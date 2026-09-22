"""Moviola: encadena generaciones reutilizando el ultimo fotograma de la anterior.

    Moviola In     -> aguas ARRIBA. Busca en la carpeta del proyecto, sirve el
                      fotograma de numeracion mas alta (o la base si no hay nada),
                      da el indice del prompt y ENSENA cual esta usando.
    Moviola Guide  -> aguas ABAJO. Ancla ese fotograma en el fotograma 0 del clip
                      nuevo, inyectando su latente como keyframe.
    Moviola Out    -> al FINAL. Guarda el ultimo fotograma del clip y su latente,
                      numerados en pareja.

POR QUE TRES NODOS Y NO UNO. La referencia hace falta ANTES de generar y el
ultimo fotograma existe DESPUES, asi que In y Out no pueden ser el mismo nodo:
seria un ciclo. Y Guide va aparte de In por lo mismo: In alimenta al Multi-Prompt
y a las referencias, o sea que esta aguas arriba del condicionamiento; si ademas
lo consumiera, dependeria de lo que ayuda a producir. ComfyUI rechaza los ciclos.

POR QUE UN KEYFRAME Y NO UNA REFERENCIA. Lo que une dos tomas no es una
referencia: un ref (ref_images, un RefMod) le dice al modelo COMO ES el sujeto y
se atiende en toda la secuencia, sin posicion temporal. Solo un keyframe lleva
`resolved_frame_index`, y es lo unico que ancla el fotograma 0. Con referencias
la identidad se mantiene pero las tomas no empalman.

POR QUE MOVIOLA CONSTRUYE EL KEYFRAME A MANO. El nodo nativo `Add Guide` tambien
crea keyframes, pero toma IMAGE y hace `vae.encode()` por dentro, obligando a
pasar por un PNG de 8 bits y a recodificar en cada vuelta. Aqui el keyframe se
arma con la latente que guardo Out -- es un diccionario con `resolved_frame_index`
y `latent`, nada mas -- y el viaje por el VAE desaparece del bucle.

WHY THREE NODES. The reference is needed BEFORE generating and the last frame
only exists AFTER, so In and Out cannot be one node: that is a cycle. Guide is
separate from In for the same reason: In feeds Multi-Prompt and the references,
so it sits upstream of the conditioning; consuming it too would make it depend on
what it helps produce.

WHY A KEYFRAME, NOT A REFERENCE. What joins two takes is not a reference: a ref
(ref_images, a RefMod) tells the model what the subject LOOKS LIKE and is attended
across the whole sequence with no temporal position. Only a keyframe carries
`resolved_frame_index`, and it is the only thing that anchors frame 0.

WHY THE KEYFRAME IS BUILT BY HAND. The native `Add Guide` also makes keyframes,
but it takes IMAGE and calls `vae.encode()` internally, forcing a trip through an
8-bit PNG and a re-encode every pass. Here it is assembled from the latent Out
saved, and the VAE round trip leaves the loop.
"""

import asyncio
import glob
import os
import re
import io
import shutil
import time
from fractions import Fraction

# PyAV. Enlaza libavcodec/libavformat DENTRO de este mismo proceso, asi que el
# montaje no lanza nada ni necesita ninguna herramienta externa instalada. Y
# `av>=17` es requisito del propio ComfyUI, no de un pack de terceros, asi que lo
# tiene todo el mundo.
#
# Antes el montaje dependia de dos utilidades de linea de comandos que no siempre
# estan las dos: `imageio-ffmpeg`, que instala VideoHelperSuite, solo trae una, y
# a quien le faltaba la otra se le quedaba el montaje sin hacer y sin saber por
# que.
#
# PyAV links libavcodec/libavformat INSIDE this process, so the montage starts
# nothing and needs no external tool installed. `av>=17` is a requirement of
# ComfyUI itself, so everyone already has it.
import av
import numpy as np
import torch
from PIL import Image

import folder_paths
import node_helpers
from aiohttp import web
from server import PromptServer

try:
    from .. import __version__ as ACADEMIASD_VERSION
except Exception:
    ACADEMIASD_VERSION = "2.4.9"

try:
    from safetensors.torch import load_file as _st_load
    from safetensors.torch import save_file as _st_save
except Exception:                                      # pragma: no cover
    _st_load = _st_save = None

# nombre_00001_.png
PATRON = r"^{}_(\d+)_?\.{}$"

# comfy/ldm/minimax/model.py:30 -- salvo el primero, cada fotograma latente
# codifica CUATRO reales. Hace falta para traducir la longitud latente del clip
# destino a fotogramas de verdad y poder comprobar `frame_idx`.
# Every latent frame but the first encodes FOUR real ones; needed to turn the
# target's latent length into real frames and validate `frame_idx`.
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)


def _fotogramas_de(latente_t):
    """Cuantos fotogramas reales cubren `latente_t` fotogramas latentes."""
    return sum(FRAME_PER_TOKEN[k % 5] for k in range(int(latente_t)))


# -- rutas y numeracion ------------------------------------------------------

def _partes(project_path):
    """'carpeta/nombre' -> (directorio absoluto, nombre base).

    Se resuelve siempre bajo output/, como cualquier nodo que guarda, para que
    una ruta con '..' no pueda escribir fuera.
    Always resolved under output/, like any saving node, so a path containing
    '..' cannot write outside it.
    """
    out = os.path.abspath(folder_paths.get_output_directory())
    limpio = (project_path or "").replace("\\", "/").strip("/")
    if not limpio:
        limpio = "moviola/toma"
    sub = os.path.dirname(limpio)
    nombre = os.path.basename(limpio) or "toma"
    carpeta = os.path.abspath(os.path.join(out, sub) if sub else out)
    if os.path.commonpath([carpeta, out]) != out:
        raise ValueError("[Moviola] project_path sale de la carpeta output "
                         "/ project_path escapes the output folder")
    return carpeta, nombre


def _ultimo(carpeta, nombre, ext):
    """(numero, ruta) del mayor existente, o (0, None).

    Ordenado por el ENTERO, no por el nombre: alfabeticamente _00010_ quedaria
    antes que _00009_ en cuanto el bucle pasara de nueve vueltas.
    Sorted by the INTEGER, not by name: alphabetically _00010_ would sort before
    _00009_ as soon as the loop passed nine.
    """
    if not os.path.isdir(carpeta):
        return 0, None
    pat = re.compile(PATRON.format(re.escape(nombre), ext))
    mejor_n, mejor_f = 0, None
    for f in os.listdir(carpeta):
        m = pat.match(f)
        if m:
            n = int(m.group(1))
            if n > mejor_n:
                mejor_n, mejor_f = n, os.path.join(carpeta, f)
    return mejor_n, mejor_f


def _ruta_latente(carpeta, nombre, n):
    if not n:
        return None
    return os.path.join(carpeta, "{}_{:05}_.safetensors".format(nombre, n))


# -- latentes e imagenes -----------------------------------------------------

def _ultima_latente(samples, cuantos=1):
    """El ultimo fotograma latente, venga con la forma que venga.

    H3 empaqueta video y audio en un NestedTensor y aqui solo interesa el video,
    que es el tensor 0. Un latente de video suelto es [B,C,T,H,W] y se recorta
    por T; uno de imagen es [B,C,H,W] y ya es un unico fotograma.

    H3 packs video and audio into a NestedTensor and only the video half (tensor
    0) matters here. A plain video latent is [B,C,T,H,W] and is sliced on T; an
    image latent is [B,C,H,W] and is already a single frame.
    """
    if getattr(samples, "is_nested", False):
        samples = samples.tensors[0]
    if samples.ndim == 5:
        n = max(1, min(int(cuantos), int(samples.shape[2])))
        return samples[:, :, -n:, :, :].clone()
    return samples.clone()


def _guardar_base(carpeta, nombre, imagen):
    """Deja la imagen de partida como `nombre_00000_.png`.

    El fotograma que arranca la vuelta N es el ultimo de la N-1, y esa cadena se
    corta en la primera: la imagen base no vive en la carpeta del proyecto. Con
    el cero la cadena queda completa y ademas queda constancia de CON QUE imagen
    se hizo la serie, que hoy no consta en ningun sitio -- si se cambia la
    referencia y se regenera, no hay forma de saber cual uso la serie anterior.

    El cero no estorba a nadie: `_ultimo` exige `n > mejor_n` partiendo de 0, asi
    que nunca se sirve como ancla, y `_borrar` recorre `while n > 0`, asi que
    tampoco se lo lleva por delante al deshacer una toma.

    Saves the starting image as `name_00000_.png`. Frame N starts from take N-1's
    last, and that chain breaks at the first take because the base image does not
    live in the project folder. Zero completes it and records WHICH image the
    series was made from, which nothing does today. It is inert: `_ultimo` starts
    at 0 and demands `n > best`, so it is never served as an anchor, and `_borrar`
    walks `while n > 0`, so undoing takes never removes it.
    """
    destino = os.path.join(carpeta, "{}_{:05}_.png".format(nombre, 0))
    if os.path.exists(destino):
        return
    try:
        os.makedirs(carpeta, exist_ok=True)
        # `format` explicito: PIL deduce el formato de la extension y aqui se
        # escribe a un `.tmp`, que no le dice nada.
        # Explicit `format`: PIL infers it from the extension and this writes to
        # a `.tmp` first, which tells it nothing.
        tmp = destino + ".tmp"
        _tensor_a_pil(imagen).save(tmp, format="PNG", compress_level=4)
        os.replace(tmp, destino)
    except Exception as exc:
        # Es documentacion, no parte del bucle: si falla, la serie sigue.
        # Documentation, not part of the loop: a failure must not stop the run.
        print("[Moviola In] no se pudo guardar la base / could not save the base: "
              "{}".format(exc))


def _encajar(z, alto, ancho):
    """La misma latente, interpolada a `alto` x `ancho` en el espacio latente.

    Existe para los flujos con reescalado por latentes. Ahi la toma se genera a
    baja resolucion, se reescala en un segundo paso de muestreo, y lo que acaba
    en el video es LO REESCALADO. Si el ancla es la latente base, el ultimo
    fotograma del video y el que ancla la toma siguiente no son el mismo: el
    segundo paso no solo anade detalle, regenera. De ahi el salto en la costura.

    Guardando la reescalada y encajandola aqui, el ancla lleva el contenido que
    de verdad se vio y la geometria en la que se va a generar. Es la operacion
    simetrica a la que hace el reescalador, que interpola hacia arriba.

    Es una aproximacion: interpolar latentes no es exacto. Para un keyframe
    basta, porque condiciona y no se pega -- ver la cabecera del fichero.

    Exists for latent-upscaling workflows, where the take is generated small,
    upscaled by a second sampling pass, and it is the UPSCALED result that ends
    up in the video. Anchoring on the base latent means the video's last frame
    and the next take's anchor are not the same frame, since the second pass
    regenerates rather than just adding detail. Symmetric to what the upscaler
    does. An approximation, and enough for something that conditions.
    """
    if z.ndim == 5:
        b, c, t, h, w = z.shape
        plano = z.permute(0, 2, 1, 3, 4).reshape(b * t, c, h, w)
        plano = torch.nn.functional.interpolate(
            plano, size=(alto, ancho), mode="bilinear", align_corners=False)
        return plano.reshape(b, t, c, alto, ancho).permute(0, 2, 1, 3, 4).contiguous()
    if z.ndim == 4:
        return torch.nn.functional.interpolate(
            z, size=(alto, ancho), mode="bilinear", align_corners=False).contiguous()
    return z


def _tensor_a_pil(imagen):
    x = imagen[0] if imagen.ndim == 4 else imagen
    x = (x.detach().cpu().float().clamp(0.0, 1.0).numpy() * 255.0).astype(np.uint8)
    return Image.fromarray(x)


def _vista_previa(imagen, etiqueta):
    """PNG en temp/ para que el nodo pueda ensenar lo que maneja.

    Una vista previa que falla no debe tumbar la ejecucion: es informativa y el
    bucle tiene que seguir aunque no se pueda pintar.
    A failed preview must not take the run down with it: it is informational and
    the loop has to carry on even if nothing can be drawn.
    """
    try:
        tmp = folder_paths.get_temp_directory()
        os.makedirs(tmp, exist_ok=True)
        f = "moviola_{}.png".format(re.sub(r"[^A-Za-z0-9_-]", "_", etiqueta)[:48])
        _tensor_a_pil(imagen).save(os.path.join(tmp, f), compress_level=4)
        return [{"filename": f, "subfolder": "", "type": "temp"}]
    except Exception as exc:
        print("[Moviola] vista previa fallida / preview failed: {}".format(exc))
        return []


# -- IN ----------------------------------------------------------------------

class AcademiaMoviolaIn:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "project_path": ("STRING", {"default": "moviola/toma"}),
                # Elige QUE imagen sale por `image`, no si sale. El cable se queda
                # puesto en los dos casos, asi que el mismo grafo sirve para las
                # dos formas de encadenar.
                #
                # `new frame` -- sale lo que el nodo acaba de leer: la base en la
                #     vuelta 1 y el ultimo fotograma generado de la 2 en adelante.
                #     Es lo que encadena por `first_frame`, donde la imagen fija el
                #     fotograma 0 y tiene que avanzar en cada vuelta.
                #
                # `pass through` -- sale la MISMA imagen que entro por
                #     `base_image`, vuelta tras vuelta, sin tocar el disco. Es lo
                #     que hace falta en una ranura de referencia: ahi la imagen
                #     dice COMO ES el sujeto y debe ser la misma toda la serie. Si
                #     ahi entrara el fotograma generado, cada vuelta cambiaria de
                #     referencia y ademas arrastraria el final del clip hacia esa
                #     composicion, porque una referencia se atiende durante todo el
                #     clip. Por esa via la continuidad la pone Guide con el
                #     keyframe.
                #
                # Sin nada conectado a `base_image`, `pass through` saca None y no
                # es un error: es el caso normal de una serie que arranca solo con
                # el prompt.
                #
                # Picks WHICH image leaves through `image`, not whether one does.
                # The wire stays connected either way, so one graph serves both
                # ways of chaining. `new frame`: what the node just read -- the
                # base on pass 1, the last generated frame from pass 2 on -- which
                # is what chains through `first_frame`, where the image fixes frame
                # 0 and must advance every pass. `pass through`: the SAME image
                # that came in through `base_image`, pass after pass, never
                # touching disk -- what a reference slot needs, since there the
                # image says WHAT THE SUBJECT LOOKS LIKE and must stay the same all
                # series. With nothing wired to `base_image`, `pass through` yields
                # None and that is not an error: it is the ordinary case of a
                # series starting from the prompt alone.
                "image_out": ("BOOLEAN", {"default": True,
                                          "label_on": "new frame",
                                          "label_off": "pass through"}),
            },
            "optional": {
                "base_image": ("IMAGE",),
            },
        }

    # next_index es el que va al Multi-Prompt, NO un contador propio. Vale
    # cuantos fotogramas hay ya en la carpeta MAS UNO: 1 en la primera vuelta, 2
    # en la segunda. El Multi-Prompt cuenta desde 1, asi que encaja directo.
    #
    # next_index is what feeds Multi-Prompt. It is the number of frames already in
    # the folder PLUS ONE: 1 on the first pass, 2 on the second. Multi-Prompt is
    # one-based, so it lines up directly.
    RETURN_TYPES = ("IMAGE", "INT", "STRING", "STRING")
    RETURN_NAMES = ("image", "next_index", "source", "project_path")
    FUNCTION = "servir"
    CATEGORY = "Academia SD/Moviola"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        # Lee del disco, que cambia entre ejecuciones aunque las entradas no.
        # Reads from disk, which changes between runs though the inputs do not.
        return float("NaN")

    def servir(self, project_path, image_out=True, base_image=None):
        carpeta, nombre = _partes(project_path)
        n, fichero = _ultimo(carpeta, nombre, "png")

        if n == 0:
            if base_image is None:
                # Primera vuelta SIN imagen: texto a video puro, sin ancla. Esto
                # antes era un error, pero nada impide arrancar una serie solo con
                # el prompt -- y `None` es valido aguas abajo: ReferenceToVideo
                # hace `if img is None: continue` al recorrer ref_images, y en
                # ImageToVideo `first_frame` es opcional. De la segunda vuelta en
                # adelante ya hay fotograma y todo sigue igual.
                #
                # First pass with NO image: plain text-to-video, no anchor. This
                # used to raise, but nothing stops a series starting from the
                # prompt alone, and `None` is valid downstream: ReferenceToVideo
                # skips null refs and ImageToVideo's `first_frame` is optional.
                imagen = None
                origen = "text only"
                print("[Moviola In v{}] primera vuelta sin imagen base: texto a "
                      "video / first pass, no base image: text to video".format(
                          ACADEMIASD_VERSION))
            else:
                imagen = base_image
                origen = "base"
                _guardar_base(carpeta, nombre, base_image)
                print("[Moviola In v{}] carpeta vacia, sirviendo la base "
                      "/ empty folder, serving the base".format(ACADEMIASD_VERSION))
        else:
            img = Image.open(fichero).convert("RGB")
            imagen = torch.from_numpy(np.array(img).astype(np.float32) / 255.0).unsqueeze(0)
            origen = os.path.basename(fichero)
            print("[Moviola In v{}] sirviendo {} / serving {}".format(
                ACADEMIASD_VERSION, origen, origen))

        vista = _vista_previa(imagen, nombre + "_in") if imagen is not None else []
        # La salida `image` lleva el fotograma con el que arranca la vuelta, y
        # existe para una entrada concreta: `first_frame` de ImageToVideo. Ahi no
        # es una referencia, es el fotograma 0 y nada mas, asi que encadenar por
        # ese camino es legitimo.
        #
        # NO conectarla a una ranura de `ref_images`. Una referencia no tiene
        # posicion temporal: se atiende durante todo el clip y arrastra tambien su
        # FINAL hacia esa composicion, de modo que la toma se mueve y acaba donde
        # empezo. Medido sobre dos vueltas encadenadas -- la segunda se movio mas
        # que la primera (8.86 contra 6.00 de media entre fotogramas) y aun asi
        # termino a 2.78 sobre 255 de donde habia salido. Y de paso ocupa una
        # ranura y corre la numeracion de <Picture N>, porque una ranura nula no
        # deja hueco. Por ese camino la continuidad ya la pone Guide, que fabrica
        # el keyframe leyendo la latente del disco sin pasar por un PNG.
        #
        # The `image` output carries the frame the pass starts from, and it exists
        # for one input in particular: ImageToVideo's `first_frame`. There it is
        # not a reference, it is frame 0 and nothing else, so chaining through it
        # is legitimate.
        #
        # Do NOT wire it into a `ref_images` slot. A reference carries no temporal
        # position: it is attended across the whole clip and drags its ENDING back
        # to that composition, so the take moves and finishes where it began.
        # Measured across a chained pair -- the second moved more than the first
        # (8.86 against 6.00 mean frame delta) and still ended 2.78/255 from where
        # it started. It also eats a slot and shifts the <Picture N> numbering,
        # since a null slot leaves no gap. Down that route Guide already provides
        # continuity, building the keyframe from the latent on disk with no PNG in
        # between.
        # La vista previa se pinta igual con la salida cerrada: enseña lo que el
        # nodo ha leido, que es informacion util aunque no salga por el cable.
        # The preview is drawn either way: it shows what the node read, which is
        # worth seeing even when nothing leaves through the wire.
        return {"ui": {"images": vista},
                "result": (imagen if image_out else base_image, n + 1, origen, project_path)}


# -- GUIDE -------------------------------------------------------------------

class AcademiaMoviolaGuide:
    """Ancla el ultimo fotograma en el fotograma 0, sin pasar por el VAE."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "positive": ("CONDITIONING",),
                "project_path": ("STRING", {"default": "moviola/toma"}),
                "frame_idx": ("INT", {"default": 0, "min": 0, "max": 9999}),
                "check_resolution": ("BOOLEAN", {
                    "default": False,
                    "label_on": "check", "label_off": "fit",
                    "tooltip": "What to do when the saved frame and the target clip "
                               "have different latent sizes. 'fit' rescales the frame "
                               "to the target, which is what a latent-upscaling loop "
                               "needs. 'check' refuses instead, to catch a resolution "
                               "changed by mistake mid-project."}),
            },
            "optional": {
                "av_latent": ("LATENT",),
            },
        }

    RETURN_TYPES = ("CONDITIONING",)
    RETURN_NAMES = ("positive",)
    FUNCTION = "anclar"
    CATEGORY = "Academia SD/Moviola"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("NaN")

    def anclar(self, positive, project_path, frame_idx=0, check_resolution=False,
               av_latent=None):
        carpeta, nombre = _partes(project_path)
        n = _ultimo(carpeta, nombre, "png")[0]
        f_lat = _ruta_latente(carpeta, nombre, n)

        if not f_lat or not os.path.isfile(f_lat) or _st_load is None:
            print("[Moviola Guide] sin latente que anclar; el condicionamiento pasa sin "
                  "tocar (primera vuelta, o Out.latent sin conectar) / no latent to "
                  "anchor, conditioning passed through unchanged")
            return (positive,)

        # .clone() no es precaucion: safetensors deja el fichero MAPEADO, y en
        # Windows un fichero mapeado no se puede borrar ni sobrescribir mientras
        # viva el proceso. Sin esto la carpeta se vuelve imborrable.
        # .clone() is not belt-and-braces: safetensors leaves the file MEMORY-MAPPED
        # and on Windows a mapped file cannot be deleted or overwritten while the
        # process lives.
        z = _st_load(f_lat)["samples"].clone()

        # La geometria del keyframe tiene que ser la del clip destino. Que hacer
        # cuando no lo es depende de por que no lo es, y eso no lo puede adivinar
        # el nodo:
        #
        #   fit   -> es un bucle con reescalado por latentes. Se guarda la latente
        #            reescalada, que es la que corresponde al video que se monta, y
        #            aqui se encaja a la geometria en la que se genera la toma
        #            siguiente. Sin esto el ancla apunta a un fotograma distinto del
        #            que se vio y la costura salta.
        #   check -> no deberia pasar. Se para aqui, en el nodo que lo causa, en vez
        #            de dejar que reviente dentro del muestreador con una traza que
        #            no menciona a Moviola.
        #
        # Encajar NUNCA es silencioso: se escribe siempre de que a que.
        #
        # What to do about a mismatch depends on why it happened, which the node
        # cannot guess. Fitting is for latent-upscaling loops, where the upscaled
        # latent is the one matching the video that gets cut together. Checking is
        # for the mistake the message was written for. Fitting is never silent.
        if av_latent is not None:
            dest = av_latent["samples"]
            if getattr(dest, "is_nested", False):
                dest = dest.tensors[0]
            if dest.ndim == 5 and tuple(z.shape[3:]) != tuple(dest.shape[3:]):
                if check_resolution:
                    raise ValueError(
                        "[Moviola Guide] El fotograma guardado es {}x{} latente y el "
                        "clip destino {}x{}. Vacia la carpeta, vuelve a la resolucion "
                        "anterior, o pon check_resolution en 'fit'. / Saved frame is "
                        "{}x{} in latent space and the target clip is {}x{}. Empty the "
                        "folder, go back to the previous resolution, or set "
                        "check_resolution to 'fit'."
                        .format(z.shape[3], z.shape[4], dest.shape[3], dest.shape[4],
                                z.shape[3], z.shape[4], dest.shape[3], dest.shape[4]))
                antes = (z.shape[3], z.shape[4])
                z = _encajar(z, int(dest.shape[3]), int(dest.shape[4]))
                print("[Moviola Guide] encajado {}x{} -> {}x{} / fitted".format(
                    antes[0], antes[1], z.shape[3], z.shape[4]))

            # Un indice fuera del clip no revienta: coloca el ancla mas alla de la
            # linea de tiempo del destino y el keyframe simplemente NO HACE NADA.
            # Eso es peor que un error -- la toma sale sin anclar y nada lo dice,
            # asi que se busca la causa en el prompt o en el modelo. El nodo nativo
            # `MiniMaxH3AddGuide` tambien lo comprueba.
            #
            # An out-of-range index does not crash: it places the anchor past the
            # target's timeline and the keyframe simply DOES NOTHING. That is worse
            # than an error -- the take comes out unanchored with nothing to say so.
            if dest.ndim == 5:
                cuantos = _fotogramas_de(dest.shape[2])
                if frame_idx >= cuantos:
                    raise ValueError(
                        "[Moviola Guide] frame_idx {} pero el clip destino tiene {} "
                        "fotogramas (0 a {}). Fuera de rango el ancla no hace nada y "
                        "la toma sale sin encadenar. / frame_idx {} but the target "
                        "clip has {} frames (0 to {}). Out of range the anchor does "
                        "nothing and the take comes out unchained."
                        .format(frame_idx, cuantos, cuantos - 1,
                                frame_idx, cuantos, cuantos - 1))

        kfs = list((positive[0][1] or {}).get("minimax_keyframes", []))
        kfs.append({"resolved_frame_index": int(frame_idx), "latent": z})
        salida = node_helpers.conditioning_set_values(positive, {"minimax_keyframes": kfs})
        print("[Moviola Guide v{}] keyframe en el fotograma {} desde {} {} "
              "(sin pasar por el VAE) / keyframe at frame {}, no VAE round trip".format(
                  ACADEMIASD_VERSION, frame_idx, os.path.basename(f_lat),
                  tuple(z.shape), frame_idx))
        return (salida,)


# -- OUT ---------------------------------------------------------------------

class AcademiaMoviolaOut:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "project_path": ("STRING", {"default": "moviola/toma"}),
                "latent_frames": ("INT", {"default": 1, "min": 1, "max": 8}),
                # Cuantos fotogramas ANTES del final se guarda. 0 es el ultimo,
                # que es lo de siempre; 4 es el cuarto antes del final.
                #
                # Para que sirve: el clip siguiente no arranca en el ultimo
                # fotograma de este, arranca ANTES y va a parar a el. Medido en
                # dos costuras seguidas, el fotograma 4 del clip nuevo es el que
                # reproduce el ultimo del anterior, asi que su fotograma 0
                # equivale a cuatro antes del final. Cuando esta imagen alimenta
                # `first_frame`, darle el ultimo le dice al modelo que el
                # fotograma 0 es algo que el keyframe coloca en el 4: dos ordenes
                # peleandose. El desplazamiento las pone de acuerdo.
                #
                # El valor que sale de la cuenta es `_fotogramas_de(lf) - 1`:
                # 0 con latent_frames 1, 4 con 2, 8 con 3. Se deja a mano y a 0
                # por defecto porque solo esta medido el caso de 2.
                #
                # How many frames BEFORE the end to save. 0 is the last one, the
                # long-standing behaviour. The next clip does not start on this
                # clip's last frame, it starts EARLIER and arrives at it: measured
                # across two consecutive seams, frame 4 of the new clip is the one
                # reproducing the previous last frame. When this image feeds
                # `first_frame`, handing over the last frame tells the model that
                # frame 0 is something the keyframe places at frame 4 -- two
                # orders fighting. The offset makes them agree. The derived value
                # is `_fotogramas_de(lf) - 1`; left manual and at 0 because only
                # latent_frames = 2 has been measured.
                "frames_back": ("INT", {"default": -1, "min": -1, "max": 32,
                                       "tooltip": "-1 derives it from latent_frames, which is what you want. 0 keeps the last frame."}),
            },
            "optional": {
                "images": ("IMAGE",),
                "latent": ("LATENT",),
            },
        }

    # `latent_frames` sale tal cual para que el montador no tenga que repetirlo.
    # Es el valor que decide cuanto rebobina el modelo, o sea cuanto sobra en
    # cada costura: tenerlo escrito en dos widgets es tenerlo mal en cuanto se
    # cambia uno. Sacarlo por aqui no cierra ningun ciclo, porque el montador es
    # terminal y no devuelve nada.
    #
    # `latent_frames` comes straight out so the editor need not repeat it. It is
    # what decides how far the model rewinds -- how much is spare at each seam --
    # and holding it in two widgets means holding it wrong the moment one of them
    # changes. No cycle: the editor is terminal and returns nothing.
    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("path", "latent_frames")
    FUNCTION = "guardar"
    OUTPUT_NODE = True
    CATEGORY = "Academia SD/Moviola"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("NaN")

    def guardar(self, project_path, latent_frames=1, frames_back=0,
                images=None, latent=None):
        if images is None and latent is None:
            raise ValueError("[Moviola Out] Conecta images, latent o ambos. "
                             "/ Connect images, latent or both.")

        carpeta, nombre = _partes(project_path)
        os.makedirs(carpeta, exist_ok=True)
        n = _ultimo(carpeta, nombre, "png")[0] + 1
        base = os.path.join(carpeta, "{}_{:05}_".format(nombre, n))

        ui = []
        if images is not None:
            # Solo el ULTIMO fotograma: es el unico que encadena con la toma
            # siguiente, y guardar los demas llenaria el disco sin aportar nada.
            # Only the LAST frame: it is the one that chains into the next take,
            # and keeping the rest would fill the disk for nothing.
            # -1 lo deduce de `latent_frames`, que esta en el widget de arriba.
            # El keyframe ocupa los primeros `lf` tokens del clip NUEVO, y ahi el
            # token 0 decodifica un fotograma y el resto cuatro, asi que el clip
            # nuevo arranca `_fotogramas_de(lf) - 1` fotogramas antes del final
            # del anterior. Comprobado: 4 con latent_frames 2 y 8 con 3, que es
            # donde cayo el hoyo al montar esas series.
            #
            # -1 derives it from `latent_frames`, the widget just above. The
            # keyframe takes the first `lf` tokens of the NEW clip, where token 0
            # decodes one frame and the rest four, so the new clip starts
            # `_fotogramas_de(lf) - 1` frames before the previous ending.
            # Verified: 4 at latent_frames 2 and 8 at 3, which is where the dip
            # landed when those series were joined.
            atras = int(frames_back)
            if atras < 0:
                atras = max(0, _fotogramas_de(int(latent_frames)) - 1)
            total = int(images.shape[0])
            if atras >= total:
                # Pedir mas atras de lo que dura el clip no puede saltar al clip
                # anterior, que no esta aqui: se avisa y se coge el primero.
                # Asking further back than the clip lasts cannot reach into the
                # previous clip, which is not here: say so and take the first.
                print("[Moviola Out] frames_back {} pero el clip tiene {} "
                      "fotogramas; se coge el primero / clip has only {} frames, "
                      "taking the first".format(atras, total, total))
                atras = total - 1
            ultimo = images[total - 1 - atras:total - atras]
            if atras:
                print("[Moviola Out] guardando {} fotogramas antes del final{} "
                      "/ saving {} frames before the end".format(
                          atras, " (de latent_frames)" if int(frames_back) < 0 else "",
                          atras))
            _tensor_a_pil(ultimo).save(base + ".png", compress_level=4)
            ui = _vista_previa(ultimo, nombre + "_out")

        if latent is not None:
            if _st_save is None:
                print("[Moviola Out] safetensors no disponible; la latente no se guarda "
                      "/ safetensors unavailable, latent not saved")
            else:
                # CUANTOS fotogramas latentes se guardan, y por que importa.
                #
                # El VAE de video de H3 comprime en el tiempo con FRAME_PER_TOKEN =
                # (1, 4, 4, 4, 4): salvo el primero, cada fotograma latente codifica
                # CUATRO fotogramas reales. Asi que el ultimo no es una imagen fija,
                # lleva dentro la direccion y la velocidad del movimiento -- que es
                # justo lo que una imagen codificada no tiene, y por lo que anclar
                # con un PNG deja que la camara arranque en sentido contrario.
                #
                # Guardar mas de uno da mas trayectoria, a cambio de que el clip
                # nuevo empiece reproduciendo mas pasado: cada fotograma latente son
                # ~4 fotogramas reales que hay que recortar luego en el montaje.
                #
                # HOW MANY latent frames get saved, and why it matters. H3's video
                # VAE compresses time as FRAME_PER_TOKEN = (1, 4, 4, 4, 4): every
                # latent frame but the first encodes FOUR real frames. So the last
                # one is not a still, it carries the direction and speed of the
                # motion -- exactly what an encoded image lacks, which is why
                # anchoring with a PNG lets the camera start off the wrong way.
                # Saving more gives more trajectory, at the cost of the new clip
                # opening by replaying more of the past: roughly 4 real frames per
                # latent frame, to be trimmed later in the edit.
                z = _ultima_latente(latent["samples"], latent_frames)
                # A un temporal y luego os.replace: un fichero a medio escribir lo
                # leeria Guide en la vuelta siguiente y reventaria.
                # Temp file then os.replace: a half-written file would be read by
                # Guide on the next pass and blow up.
                tmp = base + ".safetensors.tmp"
                _st_save({"samples": z.contiguous().cpu()}, tmp)
                os.replace(tmp, base + ".safetensors")
                print("[Moviola Out v{}] latente {} -> {}.safetensors".format(
                    ACADEMIASD_VERSION, tuple(z.shape), os.path.basename(base)))

        print("[Moviola Out v{}] escrito {} / wrote {}".format(ACADEMIASD_VERSION, base, base))
        return {"ui": {"images": ui}, "result": (base, int(latent_frames))}


# ============================================================================
#  Film Editor
# ============================================================================
#
# Une las tomas de un proyecto y permite deshacer la ultima. Todo lo que hace
# al montar esta medido, no estimado; los numeros salen de unas quince series.
#
# 1. RECORTE. El clip nuevo no empieza donde acabo el viejo: empieza ANTES. El
#    ancla es la ultima latente y cada latente salvo la primera codifica cuatro
#    fotogramas reales, asi que el modelo recibe esa trayectoria y la vuelve a
#    dibujar antes de continuar. El solape es un REBOBINADO, no un fotograma
#    repetido, y por eso mirar solo el fotograma 0 no lo ve.
#
# 2. EXPOSICION. Cada toma se genera aparte y el nivel deriva: medido, el mismo
#    +2,5% por costura tanto con la escena a 22 de brillo como a 143. Eso es
#    ganancia, no contenido, y en nueve costuras compone un 25%.
#
# 3. AUDIO. Los fotogramas descartados son un rebobinado, asi que su sonido
#    cubre el MISMO instante que la cola anterior. Cruzarlos no desplaza nada,
#    porque el solape no se inventa: ya estaba ahi.
#
# Joins a project's takes and lets you undo the last one. Everything the montage
# does is measured, not guessed.

VENTANA_BUSQUEDA = 20       # fotogramas del clip nuevo que se exploran
FPS_POR_DEFECTO = 24.0      # solo si el contenedor no declara ninguno
HUNDIMIENTO = 0.6           # el minimo debe bajar a esto de los hombros de la V
OBJETIVO = 1.15             # cuanto debe saltar la union, en pasos normales
BUSCA_TRAS_HOYO = 8         # hasta donde se busca a partir del fondo
DISOLVENCIA = 4             # fotogramas que se mezclan cuando no hay corte bueno
UMBRAL_DISOLVER = 1.6       # a partir de este salto, mezclar en vez de cortar
SEGUNDOS_SUAVE = 10.0       # ventana de la media movil del brillo
TOPE_SUAVE = 0.18           # cuanto se deja corregir un fotograma
VENTANA_PENDIENTE = 25      # fotogramas para medir la pendiente del brillo
SIERRA_GRANDE = 8.0         # a partir de aqui, 'smooth' compensa
ANCHO_MINIATURA = 512       # ancho maximo del fotograma que va a la tira
FRAMES_POR_LATENTE = 4      # FRAME_PER_TOKEN = (1, 4, 4, 4, 4)

# prefijo_00001<lo que sea>.mp4
#
# El segundo grupo de cifras lo pone el guardador de video: con el cableado
# antiguo el prefijo salia de Moviola Out y el guardador le añadia SU contador
# detras, dejando dos numeros en el mismo nombre. Se tolera porque aqui es
# inequivoco: el numero va anclado justo detras del prefijo, asi que el primer
# grupo es siempre la toma y lo de detras sobra. (Buscando por el numero suelto
# sin anclar no lo seria -- pidiendo la toma 1, el 00001 final de
# `toma_00011__00001` casaria igual y devolveria la vuelta 11.)
#
# Y lo que venga detras del numero da igual: "-audio" es una convencion del
# guardador de video, no un requisito. Quien no guarde el proyecto con sonido
# tendra `vid_loop_00001.mp4` a secas y tiene que encontrarse igual. El sufijo
# solo se mira para desempatar cuando el mismo numero aparece dos veces: ahi gana
# el que lleve audio, porque es el clip completo.
#
# The second number group comes from the video saver: with the old wiring the
# prefix came from Moviola Out and the saver appended ITS counter. Tolerated
# because it is unambiguous here -- the number is anchored right after the
# prefix, so the first group is always the take. Whatever follows the number is
# ignored: "-audio" is the saver's convention, not a requirement, and a project
# saved without sound has a plain `vid_loop_00001.mp4` that must be found just
# the same. The suffix only breaks ties when one number appears twice.
PATRON_VIDEO = r"^{}_(\d+)(?:__\d+)?([^.]*)\.(mp4|mkv|mov|webm)$"


def _abrir(ruta):
    """Contenedor abierto, o None si el fichero no se deja leer."""
    try:
        return av.open(ruta)
    except Exception:
        return None


def _aviso(que, ruta, exc):
    """Deja constancia en consola sin tumbar el montaje.

    Un clip ilegible no debe llevarse por delante las otras nueve tomas, pero
    tampoco puede desaparecer en silencio.
    One unreadable clip must not take the other nine takes down, and must not
    vanish silently either.
    """
    print("[Moviola] {} {}: {}".format(que, os.path.basename(ruta), exc))


def _info(ruta):
    """(fps, duracion, fotogramas, hay_audio, rate, canales) leidos del contenedor.

    Esto lo hacia ffprobe. Leerlo con PyAV no es solo quitarse una dependencia:
    es que la informacion sale de la MISMA libreria que luego decodifica, asi que
    no hay dos versiones de ffmpeg que puedan discrepar.

    This used to be ffprobe. Reading it through PyAV is not only one dependency
    less: the numbers come from the same library that later decodes, so there are
    no two ffmpeg builds that can disagree.
    """
    c = _abrir(ruta)
    if c is None:
        return (FPS_POR_DEFECTO, 0.0, 0, False, 0, 0, 0, 0)
    try:
        v = c.streams.video[0] if c.streams.video else None
        a = c.streams.audio[0] if c.streams.audio else None
        fps = float(v.average_rate) if v and v.average_rate else FPS_POR_DEFECTO
        dur = float(c.duration) / av.time_base if c.duration else 0.0
        n = int(v.frames or 0) if v else 0
        if not n and fps > 0 and dur:
            n = int(round(dur * fps))
        # El ancho y el alto van al FINAL de la tupla a proposito: todo el que
        # la usa lo hace por indice, asi que anadir por detras no mueve nada.
        # Width and height go at the END on purpose: every caller indexes into
        # this tuple, so appending disturbs nobody.
        return (fps if fps > 1.0 else FPS_POR_DEFECTO, dur, n,
                a is not None, int(a.rate) if a else 0, int(a.channels) if a else 0,
                int(v.codec_context.width) if v else 0,
                int(v.codec_context.height) if v else 0)
    except Exception:
        return (FPS_POR_DEFECTO, 0.0, 0, False, 0, 0, 0, 0)
    finally:
        c.close()


def _fps(ruta):
    return _info(ruta)[0]


def _duracion(ruta):
    return _info(ruta)[1]


def _n_fotogramas(ruta):
    return _info(ruta)[2]


def _tiene_audio(ruta):
    """Si el fichero trae pista de sonido de verdad.

    No se deduce del nombre: "-audio" lo pone el guardador por convencion y quien
    no guarde el proyecto con sonido no lo tendra.
    Not inferred from the name: "-audio" is the saver's convention.
    """
    return _info(ruta)[3]


def _clips(carpeta, prefijo):
    """Los clips de ese prefijo, ordenados por su NUMERO y no por su nombre.

    Alfabeticamente _00010 iria antes que _00009 en cuanto el bucle pasara de
    nueve vueltas. / Sorted by INTEGER, not by name.
    """
    if not os.path.isdir(carpeta):
        return []
    pat = re.compile(PATRON_VIDEO.format(re.escape(prefijo)), re.IGNORECASE)
    mejor = {}
    for f in sorted(os.listdir(carpeta)):
        m = pat.match(f)
        if not m:
            continue
        n = int(m.group(1))
        cola = (m.group(2) or "").lower()
        # Desempate para un mismo numero: primero el que lleve audio, y a
        # igualdad el nombre mas corto, para no depender del orden del disco.
        clave = (0 if "audio" in cola else 1, len(f))
        if n not in mejor or clave < mejor[n][0]:
            mejor[n] = (clave, os.path.join(carpeta, f))
    return [(n, mejor[n][1]) for n in sorted(mejor)]


# -- lectura de fotogramas ---------------------------------------------------

def _fotogramas(ruta, desde, cuantos):
    """`cuantos` fotogramas seguidos desde el indice `desde`, ya en numpy.

    Antes esto escribia PNG a un temporal y luego los volvia a leer con PIL. Al
    decodificar en proceso el fotograma YA es un array: se ahorra el viaje por
    disco, la recompresion y el directorio temporal entero.

    This used to write PNGs to a temp dir and read them back with PIL. Decoding
    in-process the frame already IS an array: no disk round trip, no recompression
    and no temp directory at all.
    """
    c = _abrir(ruta)
    if c is None:
        return []
    out = []
    try:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        for i, f in enumerate(c.decode(v)):
            if i >= desde:
                out.append(f.to_ndarray(format="rgb24").astype(np.float64))
                if len(out) >= cuantos:
                    break
    except Exception as exc:
        # Se devuelve lo leido hasta aqui, que el que llama sabe manejar. Pero se
        # avisa: callarlo deja un montaje raro sin ninguna pista de por que.
        # What was read is returned and the caller handles it -- but say so:
        # swallowing it leaves an odd cut with no clue as to why.
        _aviso("no se pudieron leer fotogramas de", ruta, exc)
    finally:
        c.close()
    return out


def _ultimos_fotogramas(ruta, cuantos=2):
    """Los ultimos `cuantos` fotogramas, sin recorrer el clip entero.

    Se salta al 95% y se decodifica desde ahi guardando una ventana corta. Leer
    los 349 fotogramas para quedarse con dos es lo que hacia lento el medir.
    Seeks to 95% and keeps a short window: decoding 349 frames to keep two is
    what made measuring slow.
    """
    c = _abrir(ruta)
    if c is None:
        return []
    cola = []
    try:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        if c.duration:
            try:
                c.seek(int(c.duration * 0.95), backward=True, stream=v)
            except Exception:
                # Un seek que falla no es un fallo: se decodifica entero, mas
                # lento pero igual de correcto.
                # A failed seek is not an error: decode the lot, slower but right.
                pass  # nosec B110
        for f in c.decode(v):
            cola.append(f)
            if len(cola) > cuantos:
                cola.pop(0)
    except Exception as exc:
        _aviso("no se pudo leer el final de", ruta, exc)
    finally:
        c.close()
    return [f.to_ndarray(format="rgb24").astype(np.float64) for f in cola]


def _dif(a, b):
    return float(np.abs(a - b).mean())


def _ganancia(a, b):
    """Cuanto multiplicar el clip SIGUIENTE para igualar al anterior.

    GANANCIA por canal y no desplazamiento: el desajuste es multiplicativo -- el
    mismo +2,5% con la escena oscura y con la clara -- y un offset levantaria los
    negros del fondo. / Per-channel GAIN, not offset: the mismatch is
    multiplicative and an offset would lift the blacks.
    """
    g = []
    for ch in range(3):
        mb = b[..., ch].mean()
        g.append(1.0 if mb < 1e-6 else max(0.5, min(2.0, a[..., ch].mean() / mb)))
    return g


def _perfil(a, b, etq=""):
    """Diferencia del ultimo fotograma de A contra los primeros de B.

    El perfil sale en V y el minimo cae donde el rebobinado alcanza al clip
    anterior. Una V de verdad se hunde muy por debajo de sus dos hombros; si no
    lo hace, el plano esta casi quieto y el minimo es ruido.
    """
    # Se decodifican mas fotogramas del final de A de los que hacen falta para
    # el perfil, pero solo se GUARDA su brillo: tres numeros por fotograma en
    # vez de la imagen. Con dos no se puede medir una pendiente, y guardar
    # veinticinco imagenes por costura se comeria la memoria en una serie larga.
    #
    # More frames are decoded from A's tail than the profile needs, but only
    # their brightness is KEPT -- three numbers each instead of the image. Two
    # frames cannot give a slope, and keeping twenty-five images per seam would
    # eat memory on a long series.
    todos = _ultimos_fotogramas(a, VENTANA_PENDIENTE)
    fb = _fotogramas(b, 0, VENTANA_BUSQUEDA + 1)
    if len(todos) < 2 or len(fb) < 2:
        return None
    brillo_a = [float(np.mean(x)) for x in todos]
    brillo_b = [float(np.mean(x)) for x in fb]
    fa = todos[-2:]
    difs = [_dif(fa[1], x) for x in fb]
    k = min(range(len(difs)), key=lambda i: difs[i])
    mov = (_dif(fa[0], fa[1]) + _dif(fb[k], fb[min(k + 1, len(fb) - 1)])) / 2.0
    hombros = min(difs[0], difs[-1])
    # `difs` entera y no solo su minimo: elegir el corte necesita ver la SUBIDA
    # que viene despues del fondo, no donde esta el fondo.
    # The whole of `difs`, not just its minimum: picking the cut needs to see the
    # CLIMB after the bottom, not where the bottom is.
    return {"k": k, "dif": difs[k], "mov": mov, "difs": difs,
            "clara": difs[k] < HUNDIMIENTO * hombros, "fa": fa, "fb": fb,
            "brillo_a": brillo_a, "brillo_b": brillo_b}


def _recorte_esperado(latent_frames, fps):
    """Cuanto rebobinado cabe esperar, en fotogramas del clip ya interpolado.

    Cada latente salvo la primera codifica cuatro fotogramas reales, y la
    interpolacion a 48 fps duplica. Es una GUIA: la medida manda, esto solo
    rescata las costuras donde no hay V que medir.
    """
    reales = max(1, int(latent_frames)) * FRAMES_POR_LATENTE
    return reales * 2 if fps > 36 else reales


def _elegir_corte(p):
    """Donde cortar una costura: el fotograma en que se REANUDA el movimiento.

    El fondo de la curva es el fotograma que REPITE, y hasta ahora se cortaba
    siempre uno despues. Eso vale cuando el fondo es agudo, pero no cuando es
    plano: un fotograma mas alla sigues encima de la repeticion y la union se
    queda corta -- el paron.

    Un fondo se vuelve plano cuando el clip nuevo reproduce el final del
    anterior sin precision, y eso pasa de forma sistematica en UNA costura: la
    primera. El primer clip es el unico que se genera sin keyframe, porque
    todavia no hay latente en disco, asi que el segundo lo repite peor que el
    tercero al segundo. Medido en dos series seguidas, la primera costura
    cortando en el fondo+1 daba 0,49 y 0,71 veces el movimiento normal, mientras
    las demas quedaban entre 0,99 y 1,04.

    Asi que no se cuenta: se busca. De entre los fotogramas que siguen al fondo,
    el que deje la union saltando lo que salta un fotograma cualquiera de esa
    zona. Donde el fondo es agudo la subida es rapida y el elegido vuelve a ser
    el de siempre, asi que las costuras que ya iban bien no se mueven.

    Where to cut a seam: the frame at which the movement RESUMES.

    The bottom of the curve is the frame that REPEATS, and until now the cut was
    always one past it. That works while the bottom is sharp; it does not when
    the bottom is flat, because one frame on you are still sitting on the repeat
    and the join falls short -- the stall.

    A bottom goes flat when the new clip reproduces the previous ending
    imprecisely, and that happens systematically at ONE seam: the first. The
    first clip is the only one generated without a keyframe, since no latent is
    on disk yet, so the second reproduces it worse than the third does the
    second. Measured across two consecutive series, the first seam cut at
    bottom+1 gave 0.49 and 0.71 times the normal motion while the others landed
    between 0.99 and 1.04.

    So it is searched for rather than counted. Among the frames after the bottom,
    the one whose join moves as much as any ordinary frame of that stretch does.
    Where the bottom is sharp the climb is steep and the winner is the same frame
    as before, so the seams that already worked do not move.
    """
    k = p["k"]
    difs = p.get("difs") or []
    mov = p.get("mov") or 0.0
    # Sin movimiento con el que comparar no hay objetivo posible: se cae en la
    # regla de siempre. / With no motion to compare against there is no target:
    # fall back to the long-standing rule.
    if mov <= 1e-6 or len(difs) < k + 2:
        return k + 1
    fin = min(k + BUSCA_TRAS_HOYO, len(difs) - 1)
    candidatos = range(k + 1, fin + 1)
    if not candidatos:
        return k + 1
    # NUNCA el fondo: ese es el fotograma repetido, y conservarlo para en seco.
    # NEVER the bottom itself: that frame is the repeat, and keeping it stalls.
    return min(candidatos, key=lambda c: abs(difs[c] / mov - OBJETIVO))


def _decidir_recortes(perfiles, esperado, fijo=None):
    """Cuantos fotogramas quita cada costura.

    El minimo NO es donde cortar: es el fotograma que REPITE, el que mas se
    parece al ultimo del clip anterior. Conservarlo enseña ese instante dos veces
    y el movimiento se para. Medido sobre nueve costuras: cortando EN el minimo,
    siete cambiaban 0,18-0,49 veces el movimiento normal -- el paron. Un fotograma
    despues, seis se quedan en 1,10-1,21, que es lo que da un corte.

    El rebobinado dura lo mismo en toda la serie, asi que las costuras planas
    copian la mediana de las que si tienen V. Si ninguna la tiene, se usa
    `latent_frames` como guia.
    """
    # Un recorte impuesto a mano se aplica tal cual y no se mide nada. Existe
    # para comprobar la regla, no para usarlo a diario: la medida acierta costura
    # a costura y un numero fijo no puede.
    # A hand-set trim is applied as is and nothing is measured. It exists to check
    # the rule, not for daily use: measuring gets each seam right and one number
    # cannot.
    if fijo is not None and fijo >= 0:
        return [int(fijo)] * len(perfiles)

    elegidos = {}
    for i, p in enumerate(perfiles):
        if p and p["clara"]:
            elegidos[i] = _elegir_corte(p)
    if elegidos:
        orden = sorted(elegidos.values())
        comun = orden[len(orden) // 2]
    else:
        comun = max(1, int(esperado))
    return [elegidos.get(i, comun) for i in range(len(perfiles))]


def claras_hay(perfiles):
    return any(p and p["clara"] for p in perfiles)


def _medir(rutas, latent_frames, log, fijo=None):
    perfiles = [_perfil(rutas[i], rutas[i + 1], "s{}".format(i))
                for i in range(len(rutas) - 1)]
    fps_pista = _fps(rutas[0])
    esperado = _recorte_esperado(latent_frames, fps_pista)
    recortes = _decidir_recortes(perfiles, esperado, fijo)

    salida = []
    for i, (p, n_rec) in enumerate(zip(perfiles, recortes)):
        if p is None:
            salida.append((n_rec, [1.0, 1.0, 1.0], 0))
            continue
        # El ratio se escribe porque es lo que dice si la union sirve, y no se
        # deducia de los otros dos numeros.
        # The ratio is printed because it is what says whether the join works,
        # and it could not be worked out from the other two numbers.
        difs, mov = p.get("difs") or [], p.get("mov") or 0.0
        razon = difs[n_rec] / mov if (mov > 1e-6 and n_rec < len(difs)) else None
        # Una costura que salta mucho mas que un fotograma normal no tiene corte
        # bueno: no existe el fotograma que empalme. Ahi se mezcla en vez de
        # cortar, y la mezcla sale gratis porque los fotogramas con los que se
        # cruza son los del rebobinado, que se iban a tirar de todas formas. No
        # cruza dos momentos distintos de la accion: cruza dos versiones del
        # MISMO momento, que es por lo que cuatro fotogramas bastan y no se lee
        # como una transicion.
        #
        # Nunca mas larga que el recorte, porque son esos mismos fotogramas los
        # que la alimentan. Y el doble menos uno si el clip va interpolado, por
        # lo de siempre: el interpolador intercala, no duplica.
        #
        # A seam that jumps far more than an ordinary frame has no good cut --
        # the frame that would join does not exist. There it is blended instead,
        # and the blend is free because the frames it crosses with are the
        # rewind, thrown away anyway. It does not cross two different moments of
        # the action: it crosses two renderings of the SAME moment, which is why
        # four frames are enough and it does not read as a transition.
        #
        # Never longer than the trim, since those are the frames feeding it. And
        # 2n-1 on an interpolated clip, for the usual reason.
        largo = (DISOLVENCIA * 2 - 1) if fps_pista > 36 else DISOLVENCIA
        dis = min(largo, n_rec) if (razon is not None and razon >= UMBRAL_DISOLVER) else 0
        # La exposicion se mide contra el fotograma que SOBREVIVE al recorte. Con
        # ocho descartados, medirla contra el 0 calcula la ganancia de una imagen
        # que se tira y el cambio de tono sobrevive a la correccion.
        sup = p["fb"][min(n_rec, len(p["fb"]) - 1)]
        salida.append((n_rec, _ganancia(p["fa"][1], sup), dis))
        marca = "   {:.2f}x".format(razon) if razon is not None else ""
        if dis:
            marca += "   blend {}".format(dis)
        log.append("   seam {} -> {}   dip at {}{}   trim {}{}".format(
            i + 1, i + 2, p["k"], "" if p["clara"] else " (flat, copied)",
            n_rec, marca))
    if perfiles and not claras_hay(perfiles):
        log.append("   no clear dip anywhere: fell back to latent_frames "
                   "({} frames)".format(esperado))
    _sierra(perfiles, recortes, fps_pista, log)
    return salida


def _pendiente(brillos, fps):
    """Niveles por segundo, o None si no hay con que medirla."""
    if not brillos or len(brillos) < 4:
        return None
    y = np.asarray(brillos, dtype=np.float64)
    x = np.arange(len(y)) / float(fps)
    return float(np.polyfit(x, y, 1)[0])


def _sierra(perfiles, recortes, fps, log):
    """Cuanto rompe el brillo en cada costura, y con eso que modo conviene.

    El brillo de un clip no es plano: sube al arrancar y va cayendo. Al
    encadenar, el valor empalma -- de eso se encarga la ganancia -- pero la
    PENDIENTE cambia de golpe, y eso se ve como un latido en vez de como un
    escalon. Cuanto vale ese salto decide si merece la pena el modo 'smooth',
    que lo quita pero a cambio puede aplanar un cambio de luz real.

    Medido: con latent_frames 3 los saltos fueron 18,0 y 7,1 y 'smooth'
    mejoraba claramente; con 2 fueron 4,4 y 0,4 y 1,4, y salia perdiendo.

    How hard the brightness breaks at each seam, and which mode that calls for.
    A clip's brightness is not flat: it rises at the start and falls away. When
    chained the value joins -- the gain sees to that -- but the SLOPE changes
    abruptly, which reads as a pulse rather than a step. How big that jump is
    decides whether 'smooth' is worth it, since it removes the pulse but can
    flatten a real change of light.
    """
    saltos = []
    for p, n_rec in zip(perfiles, recortes):
        if not p:
            continue
        antes = _pendiente(p.get("brillo_a"), fps)
        despues = _pendiente((p.get("brillo_b") or [])[n_rec:], fps)
        if antes is None or despues is None:
            continue
        saltos.append(abs(despues - antes))
    if not saltos:
        return
    peor = max(saltos)
    if peor >= SIERRA_GRANDE:
        consejo = "large -- try deflicker 'smooth'"
    else:
        consejo = "small -- 'per clip' is enough"
    log.append("   brightness sawtooth: {}  ({})".format(
        " / ".join("{:.1f}".format(x) for x in saltos), consejo))


# -- audio -------------------------------------------------------------------

def _leer_audio(ruta):
    """Toda la pista en un array [canales, muestras] float32, y su frecuencia."""
    c = _abrir(ruta)
    if c is None:
        return None, 0
    try:
        if not c.streams.audio:
            return None, 0
        a = c.streams.audio[0]
        rate = int(a.rate)
        remuestreo = av.AudioResampler(format="fltp", layout="stereo", rate=rate)
        trozos = []
        for f in c.decode(a):
            for g in remuestreo.resample(f):
                trozos.append(g.to_ndarray())
        for g in remuestreo.resample(None):
            trozos.append(g.to_ndarray())
        if not trozos:
            return None, rate
        return np.concatenate(trozos, axis=-1).astype(np.float32), rate
    except Exception:
        return None, 0
    finally:
        c.close()


def _estirar(pista, destino):
    """Lleva la pista a exactamente `destino` muestras, interpolando.

    Los clips salen del generador con el audio ~26 ms MAS CORTO que el video, y
    concatenando sin mas ese hueco se acumula. Se estira, NO se rellena con
    silencio: rellenar deja un agujero a digital cero antes de cada costura,
    medido en -89,9 dBFS, que es lo que se oye como un corte seco. El estirado
    es de un 0,5%, unos nueve centesimos de tono, inaudible.

    Clips arrive with audio ~26 ms shorter than picture and that gap accumulates.
    Stretched, never padded with silence: padding leaves a digital-zero hole
    before every seam, measured at -89.9 dBFS, and that is the hard cut you hear.
    """
    if pista is None or destino <= 0:
        return None
    n = pista.shape[-1]
    if n == destino:
        return pista
    viejo = np.linspace(0.0, 1.0, n, dtype=np.float64)
    nuevo = np.linspace(0.0, 1.0, destino, dtype=np.float64)
    return np.stack([np.interp(nuevo, viejo, pista[c]) for c in range(pista.shape[0])]
                    ).astype(np.float32)


def _curva(n, subiendo):
    """Rampa de POTENCIA CONSTANTE (cuarto de seno) de `n` muestras.

    Las dos mitades del cruce son dos generaciones del mismo instante: se parecen
    pero no coinciden muestra a muestra, asi que una rampa lineal dejaria unos
    3 dB de hoyo en mitad de la ventana.
    Constant-power ramp: the two halves are two generations of the same instant,
    alike but not sample-identical, so a linear ramp would dip ~3 dB mid-window.
    """
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    t = np.linspace(0.0, 1.0, n, dtype=np.float32)
    return np.sin(t * np.pi / 2.0) if subiendo else np.cos(t * np.pi / 2.0)


def _pista_montada(rutas, recorta, duraciones, log):
    """La banda sonora completa del montaje, o None si no se puede.

    EL CRUCE SALE GRATIS DEL RECORTE. Los fotogramas descartados son un
    REBOBINADO, asi que su audio cubre el MISMO instante que la cola del clip
    anterior: estan alineados en el tiempo. Cruzarlos no desplaza nada, porque el
    solape no se inventa, ya estaba ahi. Por eso no se usa nada parecido a
    `acrossfade`, que solapa y ACORTA -- 0,25 s de desfase por costura, mas de dos
    segundos al cabo de diez clips, con el dialogo descuadrado.

    THE CROSSFADE COMES FREE FROM THE TRIM. The discarded frames are a rewind, so
    their audio covers the same instant as the previous clip's tail: crossing them
    shifts nothing because the overlap was already there.
    """
    piezas, cabezas, rate = [], [], 0
    for i, r in enumerate(rutas):
        pista, rt = _leer_audio(r)
        if pista is None:
            return None, 0
        rate = rate or rt
        if rt != rate:
            return None, 0
        fps = _fps(r)
        corte = int(round(recorta[i] / fps * rate)) if fps > 0 else 0
        cabezas.append(pista[:, :corte].copy() if corte else None)
        cuerpo = pista[:, corte:]
        piezas.append(_estirar(cuerpo, int(round(duraciones[i] * rate))))

    for i in range(1, len(piezas)):
        cab = cabezas[i]
        if cab is None or cab.shape[-1] < 8:
            continue
        w = min(cab.shape[-1], piezas[i - 1].shape[-1])
        if w < 8:
            continue
        # La cola anterior baja y la cabeza descartada sube, en la MISMA ventana.
        piezas[i - 1][:, -w:] *= _curva(w, False)
        piezas[i - 1][:, -w:] += cab[:, :w] * _curva(w, True)

    return np.concatenate(piezas, axis=-1), rate


def _escribir_audio(sal, flujo, pista, rate):
    """Mete la pista en el contenedor en bloques del tamaño del codificador."""
    bloque = flujo.codec_context.frame_size or 1024
    total = pista.shape[-1]
    pts = 0
    for ini in range(0, total, bloque):
        trozo = np.ascontiguousarray(pista[:, ini:ini + bloque])
        if trozo.shape[-1] < bloque:
            relleno = np.zeros((trozo.shape[0], bloque - trozo.shape[-1]), np.float32)
            trozo = np.concatenate([trozo, relleno], axis=-1)
        f = av.AudioFrame.from_ndarray(trozo, format="fltp", layout="stereo")
        f.rate = rate
        f.pts = pts
        f.time_base = Fraction(1, rate)
        pts += bloque
        for p in flujo.encode(f):
            sal.mux(p)
    for p in flujo.encode():
        sal.mux(p)


# -- el montaje --------------------------------------------------------------

def _curva_brillo(rutas, recorta, disolver):
    """El brillo por canal de cada fotograma DE SALIDA, en orden.

    Se recorre igual que al escribir -- mismos recortes, misma retencion para
    las mezclas -- pero guardando solo tres numeros por fotograma en vez de la
    imagen. La media de una mezcla se puede componer sin tener los pixeles
    delante, porque mezclar es lineal: la media de (1-a)*A + a*B es
    (1-a)*media(A) + a*media(B). Por eso esta pasada no gasta memoria.

    The per-channel brightness of every OUTPUT frame, in order. Walked exactly
    as the writing pass walks it -- same trims, same hold-back for the blends --
    keeping three numbers per frame instead of the image. A blend's mean can be
    composed without the pixels, because blending is linear.
    """
    curva = []
    retenidas = []
    for i, r in enumerate(rutas):
        n_entra = len(retenidas)
        n_sale = disolver[i + 1] if i + 1 < len(rutas) else 0
        desde = recorta[i] - n_entra
        c = _abrir(r)
        if c is None:
            retenidas = []
            continue
        try:
            v = c.streams.video[0]
            v.thread_type = "AUTO"
            cola = []
            for idx, f in enumerate(c.decode(v)):
                if idx < desde:
                    continue
                m = f.to_ndarray(format="rgb24").astype(np.float32).mean(axis=(0, 1))
                if idx < recorta[i]:
                    k = idx - desde
                    alfa = (k + 1.0) / (n_entra + 1.0)
                    m = (1.0 - alfa) * retenidas[k] + alfa * m
                cola.append(m)
                if len(cola) > n_sale:
                    curva.append(cola.pop(0))
            retenidas = cola
        finally:
            c.close()
    curva.extend(retenidas)
    return np.array(curva) if curva else None


def _ganancias_suaves(curva, fps):
    """Cuanto multiplicar cada fotograma para que el brillo vaya liso.

    El objetivo no es una constante: es la propia curva pasada por una media
    movil de unos diez segundos. Asi se conserva lo que la escena hace de verdad
    -- apagarse poco a poco -- y se quita el diente de sierra, cuyo periodo es
    el de un clip. Corregir contra una recta aplanaria tambien los cambios de
    luz legitimos.

    El tope existe porque una correccion grande sube el ruido y puede quemar
    altas luces. Si un tramo pide mas de lo que se le deja, se queda como esta:
    mejor un trozo algo apagado que un trozo sucio.

    The target is not a constant: it is the curve itself through a moving
    average of about ten seconds. That keeps what the scene actually does --
    fading gradually -- and removes the sawtooth, whose period is one clip.
    The cap exists because a large correction lifts noise and can burn
    highlights: better a slightly dark stretch than a dirty one.
    """
    n = len(curva)
    w = max(3, int(fps * SEGUNDOS_SUAVE)) | 1
    if n < 3:
        return np.ones_like(curva)
    m = w // 2
    ext = np.concatenate([np.repeat(curva[:1], m, axis=0), curva,
                          np.repeat(curva[-1:], m, axis=0)])
    acum = np.cumsum(ext, axis=0)
    acum = np.concatenate([np.zeros((1, curva.shape[1])), acum])
    objetivo = (acum[w:] - acum[:-w]) / float(w)
    # UNA ganancia para los tres canales, sacada de la luminancia.
    #
    # Corregir cada canal contra su propia curva convierte un estabilizador de
    # brillo en uno de color: cuando la escena cambia de tono de verdad -- unas
    # brasas, una luz calida -- la correccion pelea con ella y mete un viraje.
    # Medido sobre una serie, por canal el tono se desviaba un 1,94% de media y
    # hasta un 8,06%, que se ve como un cambio de color donde no hay costura.
    # Con una sola ganancia el tono no se puede mover, porque las proporciones
    # entre canales quedan intactas, y se sigue alisando 3,6 veces mejor que sin
    # tocar nada.
    #
    # ONE gain for all three channels, taken from luminance. Correcting each
    # channel against its own curve turns a brightness stabiliser into a colour
    # one: when the scene genuinely shifts hue the correction fights it. Measured
    # on one series, per-channel moved the hue 1.94% on average and up to 8.06%,
    # visible as a colour change away from any seam. A single gain cannot move
    # the hue at all, since the ratios between channels survive untouched.
    peso = np.array([0.2126, 0.7152, 0.0722])          # BT.709
    luz = np.maximum(curva @ peso, 1e-6)
    g = (objetivo @ peso) / luz
    g = np.clip(g, 1.0 - TOPE_SUAVE, 1.0 + TOPE_SUAVE)
    return np.repeat(g[:, None], 3, axis=1)


def _montar(rutas, destino, latent_frames, crf, log, fijo=None,
            suave=False):
    """Une los clips corrigiendo las tres costuras, sin salir del proceso."""
    dec = _medir(rutas, latent_frames, log, fijo)
    recorta = [0] + [d[0] for d in dec]
    # disolver[i] es la mezcla de la costura que hay ANTES del clip i.
    # disolver[i] is the blend of the seam BEFORE clip i.
    disolver = [0] + [(d[2] if len(d) > 2 else 0) for d in dec]

    # Con `suave` la correccion deja de ser una constante por clip y pasa a ser
    # una por fotograma, asi que las ganancias acumuladas NO se aplican: se
    # sustituyen. Hace falta una pasada previa para conocer el brillo de todo
    # antes de escribir nada.
    #
    # With `suave` the correction stops being one constant per clip and becomes
    # one per frame, so the accumulated gains are not applied -- they are
    # replaced. A first pass is needed to know the whole brightness before
    # anything is written.
    curva = _curva_brillo(rutas, recorta, disolver) if suave else None
    suaves = None
    if curva is not None and len(curva) > 2:
        suaves = _ganancias_suaves(curva, _fps(rutas[0]))
        log.append("   smooth exposure: {} frames, correction {:.3f}..{:.3f}".format(
            len(curva), float(suaves.min()), float(suaves.max())))
    elif suave:
        log.append("   smooth exposure: could not read the brightness, "
                   "falling back to per-clip gain")

    # La correccion de exposicion se ACUMULA: cada clip se iguala al anterior,
    # que a su vez ya viene igualado al suyo. Corrigiendo solo contra el vecino
    # inmediato, una deriva lenta se colaria entera a lo largo del montaje sin
    # que ninguna costura pareciera mala por separado.
    gan = [[1.0, 1.0, 1.0]]
    for d in dec:
        gan.append([gan[-1][c] * d[1][c] for c in range(3)])

    info0 = _info(rutas[0])
    fps = info0[0]
    duraciones = []
    for i, r in enumerate(rutas):
        n = _n_fotogramas(r) - recorta[i]
        duraciones.append(max(n, 1) / fps)

    con_audio = [_tiene_audio(r) for r in rutas]
    hay_audio = all(con_audio)
    if not hay_audio and any(con_audio):
        log.append("   some clips have no audio track: joining the picture only")
    elif not hay_audio:
        log.append("   no audio tracks: joining the picture only")

    pista, rate = (None, 0)
    if hay_audio:
        pista, rate = _pista_montada(rutas, recorta, duraciones, log)
        if pista is None:
            log.append("   audio tracks do not match: joining the picture only")

    primera = _abrir(rutas[0])
    if primera is None:
        raise RuntimeError("cannot open {}".format(os.path.basename(rutas[0])))
    try:
        v0 = primera.streams.video[0]
        ancho, alto = v0.codec_context.width, v0.codec_context.height
    finally:
        primera.close()

    tmp = destino + ".tmp.mp4"
    sal = av.open(tmp, "w")
    try:
        ritmo = Fraction(fps).limit_denominator(1000)
        vo = sal.add_stream("libx264", rate=ritmo)
        vo.width, vo.height, vo.pix_fmt = ancho, alto, "yuv420p"
        # La base de tiempos se fija a mano: el codec no la tiene hasta que se
        # abre el flujo, y los fotogramas se numeran antes de eso.
        # Set by hand: the codec has none until the stream is opened, and frames
        # are numbered before that happens.
        base_t = Fraction(1, 1) / ritmo
        vo.codec_context.time_base = base_t
        vo.options = {"crf": str(int(crf)), "preset": "medium"}
        ao = None
        if pista is not None:
            ao = sal.add_stream("aac", rate=rate)
            ao.layout = "stereo"

        escritos = 0

        def emitir(arr):
            """Un fotograma ya en RGB float al fichero."""
            if suaves is not None and emitir.n < len(suaves):
                s = suaves[emitir.n]
                arr = np.stack([arr[..., c] * s[c] for c in range(3)], -1)
            f = av.VideoFrame.from_ndarray(
                np.clip(arr, 0, 255).astype(np.uint8), format="rgb24")
            f.pts = emitir.n
            f.time_base = base_t
            emitir.n += 1
            for p in vo.encode(f):
                sal.mux(p)
        emitir.n = 0

        # Los ultimos fotogramas del clip anterior, retenidos sin escribir para
        # poder cruzarlos con los primeros del siguiente. Vacio = corte en seco.
        # The previous clip's last frames, held back unwritten so they can cross
        # with the next clip's first ones. Empty = a hard cut.
        retenidos = []
        for i, r in enumerate(rutas):
            g = gan[i]
            # Con la correccion por fotograma la de por clip sobra: aplicar las
            # dos seria corregir dos veces. / With the per-frame correction the
            # per-clip one is redundant: applying both corrects twice.
            toca = (suaves is None) and max(abs(x - 1.0) for x in g) >= 0.005
            n_entra = len(retenidos)          # mezcla de ESTA costura
            n_sale = disolver[i + 1] if i + 1 < len(rutas) else 0
            desde = recorta[i] - n_entra
            c = _abrir(r)
            if c is None:
                retenidos = []
                continue
            try:
                v = c.streams.video[0]
                v.thread_type = "AUTO"
                cola = []
                for idx, f in enumerate(c.decode(v)):
                    if idx < desde:
                        continue
                    arr = f.to_ndarray(format="rgb24").astype(np.float32)
                    if toca:
                        arr[..., 0] *= g[0]
                        arr[..., 1] *= g[1]
                        arr[..., 2] *= g[2]
                    if idx < recorta[i]:
                        # Fotograma de mezcla: pesa cada vez mas el clip nuevo.
                        # A blend frame: the new clip weighs more each step.
                        k = idx - desde
                        alfa = (k + 1.0) / (n_entra + 1.0)
                        arr = (1.0 - alfa) * retenidos[k] + alfa * arr
                    cola.append(arr)
                    if len(cola) > n_sale:
                        emitir(cola.pop(0))
                # Lo que queda en la cola son los de la costura siguiente.
                retenidos = cola
            finally:
                c.close()
        # El ultimo clip no tiene costura detras: lo retenido se escribe.
        # The last clip has no seam after it: whatever is held goes out.
        for arr in retenidos:
            emitir(arr)
        escritos = emitir.n
        for p in vo.encode():
            sal.mux(p)

        if ao is not None:
            _escribir_audio(sal, ao, pista, rate)
    finally:
        sal.close()

    # A un temporal y luego os.replace: un montaje a medio escribir no debe
    # quedarse con el nombre bueno.
    os.replace(tmp, destino)
    return destino


def _nombres(path):
    """(carpeta, base, prefijo de video, prefijo de interpolado).

    Los tres prefijos salen del nombre base de `path`, no estan fijados: con
    'proyecto/loop' se buscan loop_#####_.safetensors, vid_loop_#####.mp4 y
    vid_int_loop_#####.mp4, que es justo lo que sacan Moviola Out y las dos
    salidas de video de Project Paths. Con 'proyecto/toma' se buscarian toma,
    vid_toma y vid_int_toma.

    Lo que SI se da por supuesto es que los guardadores de video usan
    `vid_<base>`: si estan cableados a otro sitio no aparece nada, asi que los
    prefijos buscados se escriben en la consola para que el desajuste se lea de
    un vistazo en vez de quedar en un "nothing found" mudo.

    All three prefixes derive from `path`'s basename; none is hardcoded. What IS
    assumed is that the video savers use `vid_<base>` -- wired elsewhere nothing
    turns up, so the prefixes searched are printed to the console rather than
    leaving a silent "nothing found".
    """
    carpeta, base = _partes(path)
    return carpeta, base, "vid_" + base, "vid_int_" + base


def _titulo(carpeta, base):
    """Como se llama el montaje: el nombre del PROYECTO, no el de los ficheros.

    `base` es el prefijo de las piezas ("loop") y sale igual en todos los
    proyectos, asi que un `loop_final.mp4` no se distingue del de al lado en
    cuanto sales de su carpeta. La pelicula terminada se llama como el proyecto.

    Se coge solo el ultimo tramo de la carpeta: con un proyecto anidado,
    'a/b' daria 'a/b_final.mp4', que no es un nombre de fichero. Y si el
    proyecto vive en la raiz de output no hay carpeta propia de la que tirar, asi
    que ahi se vuelve a `base`.

    `base` is the pieces' prefix ("loop") and reads the same in every project, so
    a `loop_final.mp4` is indistinguishable from the neighbour's once it leaves
    its folder. The finished film is named after the project. Only the last path
    component is used -- a nested 'a/b' would give 'a/b_final.mp4', which is not
    a filename -- and a project living in output's root has no folder of its own,
    so it falls back to `base`.
    """
    try:
        raiz = os.path.abspath(folder_paths.get_output_directory())
    except Exception:
        raiz = None
    if raiz and os.path.abspath(carpeta) == raiz:
        return base
    return os.path.basename(os.path.abspath(carpeta)) or base


def _estado(path):
    carpeta, base, pre_v, pre_i = _nombres(path)
    lat, _ = _ultimo(carpeta, base, "safetensors")
    vids = _clips(carpeta, pre_v)
    ints = _clips(carpeta, pre_i)
    # El nombre que identifica al proyecto es su CARPETA, no `base`: base es el
    # prefijo de los ficheros ("loop") y sale igual en todos los proyectos, asi
    # que escribirlo en la consola no dice a cual se esta apuntando.
    # The project is identified by its FOLDER, not by `base`: base is the file
    # prefix ("loop") and reads the same in every project.
    out = os.path.abspath(folder_paths.get_output_directory())
    try:
        proyecto = os.path.relpath(carpeta, out).replace("\\", "/")
    except ValueError:
        proyecto = carpeta
    if proyecto == ".":
        proyecto = "(output root)"
    return {"folder": carpeta, "base": base, "project": proyecto, "latents": lat,
            "videos": len(vids), "interpolated": len(ints),
            "loop": max(lat, vids[-1][0] if vids else 0, ints[-1][0] if ints else 0)}


def _ficheros_del_loop(carpeta, n):
    """TODO lo del proyecto numerado con n, sea del prefijo que sea.

    No basta con la latente y los dos videos: quedan el png que escribe Out, el
    del guardador de video, los .tmp de una escritura cortada. Cualquiera de
    ellos sobrevive y la toma repetida arranca con restos de la anterior.
    Not just the latent and the two videos: Out's png, the video saver's own, a
    half-written .tmp. Any survivor leaves the redone take with leftovers.
    """
    marca = "_{:05}".format(n)
    fuera = []
    for f in sorted(os.listdir(carpeta)):
        completo = os.path.join(carpeta, f)
        if not os.path.isfile(completo):
            continue
        if re.search(re.escape(marca) + r"_?(?:-[A-Za-z0-9]+)?\.", f):
            fuera.append(completo)
    return fuera


# -- lo que hacen los botones ------------------------------------------------

# NO se cachea la ruta del ultimo run, a proposito.
#
# Seria comodo: `path` suele venir enlazado y un enlace solo tiene valor durante
# la ejecucion, asi que apuntar la ruta recibida daria una respuesta siempre. El
# problema es que deja de ser cierta en cuanto se cambia de proyecto, y quien la
# consulta es un boton que BORRA. Una ruta caducada ahi borra las tomas del
# proyecto anterior sin que nada lo delate.
#
# En su lugar la interfaz resuelve la ruta antes de cada accion preguntandole a
# /academia/projectpaths/resolve, que aplica la regla de verdad, y el proyecto
# al que se va a tocar aparece escrito en la consola y en la pregunta de
# confirmacion. Lo que se borra se lee antes de borrarlo.
#
# The last run's path is deliberately NOT cached. It would be convenient, but it
# stops being true the moment the project changes -- and what reads it is a
# button that DELETES. A stale path there wipes the previous project's takes with
# nothing to give it away. Instead the UI resolves the path before every action
# and the target project is spelled out in the console and in the confirmation.


def _path_de(datos):
    return str(datos.get("path") or "").strip()


def _informe(path, latent_frames=None):
    e = _estado(path)
    texto = ("Project: {}\nCurrent loop: {}\nLatents: {}   videos: {}   "
             "interpolated: {}".format(e["project"], e["loop"], e["latents"],
                                       e["videos"], e["interpolated"]))
    if not (e["videos"] or e["interpolated"]):
        _, _, pv, pi = _nombres(path)
        texto += "\nLooking for \"{}_#####.mp4\" and \"{}_#####.mp4\"".format(pv, pi)
    if latent_frames:
        # "set to" y no ":" a secas: la linea cae justo debajo de las CUENTAS de
        # ficheros, asi que un "Latent frames: 2" se lee como si hubiera dos
        # latentes. Esto es un ajuste, no un recuento.
        #
        # "set to" rather than a bare colon: the line sits right under the file
        # COUNTS, so "Latent frames: 2" reads as two latents. This is a setting.
        #
        # Se escribe para que se vea de donde sale: enlazado desde Moviola Out es
        # el mismo numero con el que se guardo la latente, y ahi no puede fallar.
        texto += "\nLatent frames set to {}".format(int(latent_frames))
    return texto


def _tamano(n):
    """Un tamano que se lee de un vistazo, que es justo de lo que va esto."""
    escala = float(n)
    for unidad in ("B", "KB", "MB", "GB"):
        if escala < 1024.0 or unidad == "GB":
            if unidad == "B":
                return "{:.0f} {}".format(escala, unidad)
            return "{:.1f} {}".format(escala, unidad)
        escala /= 1024.0


def _abrir_carpeta(path):
    """Abre la carpeta del proyecto en el gestor de ficheros. Devuelve que paso.

    Dos limites que no son un descuido y por eso se dicen en la propia consola
    en vez de callarlos:

    Solo Windows. `os.startfile` no existe en macOS ni en Linux, y alli abrir una
    carpeta obliga a lanzar un programa aparte. Fuera de Windows se dice y se
    deja la ruta, que sigue estando en la linea de arriba.

    Y abre en la maquina que corre COMFYUI, no en la que tiene el navegador. Con
    ComfyUI en un servidor la carpeta se abre alla, donde no la ve nadie. Por eso
    el listado se escribe igualmente: es lo unico que funciona en los dos casos.

    La ruta esta contenida: viene de `_nombres` -> `_partes`, que resuelve bajo
    output/ y levanta si se sale. Aqui no puede llegar una carpeta cualquiera del
    disco.

    Opens the project folder in the file manager, and says what happened. Two
    limits, stated in the console rather than hidden: `os.startfile` is Windows
    only, and it opens on the machine running COMFYUI, not the one with the
    browser -- with ComfyUI on a server the folder opens there, where nobody sees
    it. That is why the listing is printed either way. The path is contained:
    it comes from `_nombres` -> `_partes`, which resolves under output/ and
    raises if it escapes.
    """
    carpeta, _, _, _ = _nombres(path)
    if not os.path.isdir(carpeta):
        return "Nothing to open yet."
    if not hasattr(os, "startfile"):
        return "Opening a folder is Windows only -- the path is above."
    try:
        os.startfile(carpeta)
    except OSError as exc:
        return "Could not open it: {}".format(exc)
    return "Opened in the file manager of the machine running ComfyUI."


def _carpeta(path, maximo=60):
    """Que hay DE VERDAD en la carpeta del proyecto, escrito en la consola.

    El nodo sabe la ruta y el usuario no. Cuando algo no cuadra -- una vuelta
    que no aparece, un video que no se monta, un proyecto que parece vacio -- la
    pregunta siempre es la misma: que ficheros hay ahi. Esto la contesta sin
    salir de ComfyUI.

    No abre el gestor de ficheros del sistema, y no es un descuido. Para eso
    habria que lanzar un programa externo desde el servidor, que es la familia
    de llamadas que tuvo este paquete cuatro versiones marcado en el registro
    (ver el README). Ademas solo funcionaria con ComfyUI y el navegador en la
    MISMA maquina, y mucha gente lo tiene en un servidor. Una lista se lee
    igual de bien en los dos casos, y la ruta de arriba se selecciona y se pega
    en el gestor de ficheros de quien quiera abrirla.

    The node knows the path and the user does not. When something looks wrong --
    a missing pass, a cut that will not build, a project that seems empty -- the
    question is always which files are actually there, and this answers it
    without leaving ComfyUI.

    It deliberately does not open the system file manager. That would mean
    launching an external program from the server, the family of calls that kept
    this pack flagged in the registry for four versions (see the README), and it
    would only work with ComfyUI and the browser on the SAME machine, which is
    often not the case. A listing reads the same either way, and the path on the
    first line can be selected and pasted wherever the user likes.
    """
    carpeta, base, pre_v, pre_i = _nombres(path)
    completa = os.path.abspath(carpeta)
    log = ["Folder: " + completa]
    if not os.path.isdir(carpeta):
        log.append("")
        log.append("It does not exist yet -- it is created on the first pass.")
        return log

    def clase(n):
        if n.endswith("_final.mp4") or n.endswith("_final_int.mp4"):
            return "cut"
        # De prefijo mas largo a mas corto. "loop" es prefijo de nada, pero
        # los tres salen del mismo nombre base y en cuanto uno sea prefijo de
        # otro el orden decide, asi que se fija aqui y no en el orden en que
        # esten escritos.
        # Longest prefix first: all three derive from the same base name, so the
        # moment one is a prefix of another the order decides the answer.
        for prefijo, etiqueta in sorted(((pre_i, "interp"), (pre_v, "video"),
                                         (base, "take")),
                                        key=lambda x: -len(x[0])):
            if n.startswith(prefijo + "_") or n.startswith(prefijo + "."):
                return etiqueta
        return ""

    filas, total = [], 0
    for nombre in sorted(os.listdir(carpeta)):
        entero = os.path.join(carpeta, nombre)
        if not os.path.isfile(entero):
            continue
        try:
            estado = os.stat(entero)
        except OSError:
            continue
        total += estado.st_size
        filas.append((nombre, estado.st_size, estado.st_mtime, clase(nombre)))

    if not filas:
        log.append("")
        log.append("The folder is empty.")
        return log

    ancho = min(max(len(f[0]) for f in filas), 44)
    log.append("")
    recortadas = filas[:maximo]
    for nombre, bytes_, cuando, etiqueta in recortadas:
        log.append("{}  {:>10}  {}  {}".format(
            nombre.ljust(ancho), _tamano(bytes_),
            time.strftime("%Y-%m-%d %H:%M", time.localtime(cuando)), etiqueta))
    if len(filas) > maximo:
        log.append("... and {} more".format(len(filas) - maximo))

    cuenta = {}
    for f in filas:
        cuenta[f[3]] = cuenta.get(f[3], 0) + 1
    detalle = ", ".join("{} {}".format(v, k or "other")
                        for k, v in sorted(cuenta.items()))
    log.append("")
    log.append("{} files, {} -- {}".format(len(filas), _tamano(total), detalle))
    return log


def _editar(path, latent_frames, crf, fijo=None, fijo_int=None, suave=False):
    """Une los clips de cada pista. Devuelve las lineas de consola."""
    log = []
    carpeta, base, pre_v, pre_i = _nombres(path)
    titulo = _titulo(carpeta, base)
    hecho = []
    # Cada pista lleva su recorte forzado. NO puede ser el mismo numero: el
    # interpolador no duplica los fotogramas, los intercala, asi que un clip de
    # 124 sale con 247 y no con 248. Un rebobinado de n fotogramas reales ocupa
    # 2n-1 interpolados -- 5 se corresponde con 9, no con 10.
    #
    # Each track carries its own forced trim, and it cannot be the same number:
    # interpolation inserts frames rather than duplicating them, so a 124-frame
    # clip comes out at 247, not 248. A rewind of n real frames spans 2n-1
    # interpolated ones -- 5 pairs with 9, not 10.
    for etiqueta, prefijo, sufijo, forzado in (("video", pre_v, "_final", fijo),
                                               ("interpolated", pre_i, "_final_int",
                                                fijo_int)):
        clips = _clips(carpeta, prefijo)
        if not clips:
            log.append('{}: nothing found (looked for "{}_#####.mp4").'.format(
                etiqueta, prefijo))
            continue
        if len(clips) < 2:
            log.append("{}: only one clip, no videos to join.".format(etiqueta))
            continue

        rutas = [r for _, r in clips]
        destino = os.path.join(carpeta, "{}{}.mp4".format(titulo, sufijo))
        log.append("{}: joining {} clips ({} seams)".format(
            etiqueta, len(rutas), len(rutas) - 1))
        try:
            _montar(rutas, destino, latent_frames, crf, log, forzado, suave)
        except Exception as exc:
            log.append("{}: FAILED -- {}".format(etiqueta, exc))
            continue
        mb = os.path.getsize(destino) / 1048576.0
        log.append("{}: -> {}  ({:.1f} MB)".format(etiqueta, os.path.basename(destino), mb))
        hecho.append(destino)

    if not hecho and not any("joining" in x for x in log):
        log.append("No videos to join.")
    return log, hecho


def _borrar(path, todos=False):
    """Quita la ultima vuelta, o todas. Devuelve consola y el loop que queda."""
    carpeta, base, _, _ = _nombres(path)
    log = ["Project: {}".format(_estado(path)["project"])]
    if not os.path.isdir(carpeta):
        return log + ["Nothing to delete: the project folder does not exist yet."], 0

    quitados = 0
    while True:
        e = _estado(path)
        n = e["loop"]
        if n <= 0:
            break
        ficheros = _ficheros_del_loop(carpeta, n)
        if not ficheros:
            # El numero existe segun los indices pero no hay ficheros que casen:
            # sin esto el bucle no avanzaria nunca.
            log.append("Loop {}: nothing matched, stopping.".format(n))
            break
        for f in ficheros:
            try:
                os.remove(f)
                log.append("  removed {}".format(os.path.basename(f)))
            except OSError as exc:
                log.append("  COULD NOT remove {} -- {}".format(os.path.basename(f), exc))
        quitados += 1
        log.append("Loop {} deleted.".format(n))
        if not todos:
            break

    # El cero no es una vuelta: es la imagen base que escribio Moviola In, y el
    # bucle de arriba se para en 1. Con "borrarlo todo" se va tambien.
    #
    # Si no, sobrevive a un borrado completo y la tira del Multi-Prompt lo sigue
    # ensenando como primer fotograma de una serie que ya no existe. Peor aun en
    # un proyecto SIN imagen base: ahi ese png no es el arranque de nada, es un
    # resto de lo que hubiera antes en la carpeta, y engana.
    #
    # No se pierde nada: es una copia de una imagen que el usuario ya tiene, y
    # Moviola In la vuelve a escribir en la primera vuelta si `base_image` sigue
    # conectado. Borrar la ultima vuelta NO la toca -- solo el borrado completo.
    #
    # Zero is not a loop: it is the base image Moviola In wrote, and the loop
    # above stops at 1. "Delete every loop" takes it too.
    #
    # Otherwise it survives a full wipe and the Multi-Prompt strip keeps showing
    # it as the first frame of a series that no longer exists -- worse in a
    # project with NO base image, where that png starts nothing and is simply
    # whatever was in the folder before. Nothing is lost: it is a copy of an
    # image the user already has, and Moviola In writes it again on the first
    # pass while `base_image` is wired. Deleting the LAST loop never touches it.
    if todos:
        base_fuera = _ficheros_del_loop(carpeta, 0)
        for f in base_fuera:
            try:
                os.remove(f)
                log.append("  removed {}".format(os.path.basename(f)))
            except OSError as exc:
                log.append("  COULD NOT remove {} -- {}".format(os.path.basename(f), exc))
        if base_fuera:
            log.append("Base image deleted.")

    queda = _estado(path)["loop"]
    if quitados == 0:
        log.append("No loops to delete.")
    log.append("Current loop: {}".format(queda))
    if queda == 0:
        log.append("The project is empty. Moviola In writes the base again on the "
                   "next pass if one is wired.")
    return log, queda


# -- rutas de API ------------------------------------------------------------

async def _en_hilo(fn, *a):
    """Fuera del hilo del servidor: un montaje son minutos de ffmpeg, y ahi
    dentro dejaria la interfaz de ComfyUI congelada.
    Off the server thread: a montage is minutes of ffmpeg, which would freeze
    the whole ComfyUI UI from inside the event loop."""
    return await asyncio.get_event_loop().run_in_executor(None, fn, *a)


@PromptServer.instance.routes.post("/academia/moviola/status")
async def moviola_status(request):
    try:
        datos = await request.json()
        lf = int(datos.get("latent_frames") or 0)
        path = _path_de(datos)
        return web.json_response({
            "status": "success",
            "text": await _en_hilo(_informe, path, lf),
            "finals": await _en_hilo(_montajes, path),
        })
    except Exception as exc:
        return web.json_response({"status": "error", "message": str(exc)}, status=400)


def _frames(path):
    """Los fotogramas del proyecto, en orden, para la tira del Multi-Prompt.

    Se devuelven `filename` y `subfolder` en vez de una URL montada: quien pinta
    es ComfyUI, que ya sirve `output/` por `/view`, y armar aqui la ruta seria
    fijar en el servidor un detalle del cliente.

    El cero entra como el resto. Es el fotograma con el que arranca la vuelta 1
    cuando hubo imagen base; si no lo hay, esa vuelta empezo solo con el prompt.

    Returns `filename` and `subfolder` rather than a built URL: ComfyUI already
    serves `output/` through `/view`, and assembling the path here would pin a
    client detail into the server. Zero is included like any other -- it is what
    take 1 starts from when there was a base image.
    """
    carpeta, base, _, _ = _nombres(path)
    if not os.path.isdir(carpeta):
        return []
    raiz = os.path.abspath(folder_paths.get_output_directory())
    sub = os.path.relpath(carpeta, raiz).replace("\\", "/")
    if sub == ".":
        sub = ""
    pat = re.compile(PATRON.format(re.escape(base), "png"))
    salida = []
    for f in sorted(os.listdir(carpeta)):
        m = pat.match(f)
        if m:
            # La FECHA del fichero acompana a cada entrada, y con ella se
            # construye la URL en el navegador. Cambia exactamente cuando cambia
            # el contenido: ni antes, lo que obligaria a redescargar sin motivo,
            # ni despues, que es lo que deja una miniatura vieja en pantalla tras
            # rehacer una vuelta.
            #
            # The file's DATE travels with each entry and the browser builds the
            # URL from it. It changes exactly when the content does: no sooner,
            # which would force needless re-downloads, and no later, which is what
            # leaves a stale thumbnail on screen after a take is redone.
            try:
                cuando = int(os.path.getmtime(os.path.join(carpeta, f)))
            except OSError:
                cuando = 0
            salida.append({"n": int(m.group(1)), "filename": f, "subfolder": sub,
                           "mtime": cuando})
    salida.sort(key=lambda x: x["n"])
    return salida


def _vistas(path):
    """El clip de cada vuelta, para que la tira pueda reproducirlos.

    OJO con la numeracion, que no coincide con la de `_frames`: el fichero
    `loop_00003_.png` es el FINAL de la vuelta 3 y por tanto el arranque de la 4,
    mientras que `vid_loop_00003.mp4` es la vuelta 3 entera. Aqui se devuelve
    indexado por la vuelta que el clip ES, y quien pinte que lo case con la
    tarjeta que toque.

    Mind the numbering, which is not the same as `_frames`: `loop_00003_.png` is
    the END of take 3 and so the start of take 4, while `vid_loop_00003.mp4` is
    take 3 itself. This returns them keyed by the take the clip IS.
    """
    carpeta, _, pre_v, _ = _nombres(path)
    if not os.path.isdir(carpeta):
        return []
    raiz = os.path.abspath(folder_paths.get_output_directory())
    sub = os.path.relpath(carpeta, raiz).replace("\\", "/")
    if sub == ".":
        sub = ""
    # La duracion sale de la CABECERA del contenedor, no de decodificar: son
    # milisegundos por fichero y permite ensenarla en la tira. Y hace falta
    # decirla, porque el sistema no obliga a que todas las vueltas duren lo
    # mismo -- `length` se puede cambiar entre una y otra.
    #
    # The duration comes from the container HEADER, not from decoding: a few
    # milliseconds per file. It is worth showing, because nothing forces every
    # take to last the same -- `length` can change between them.
    salida = []
    for n, r in _clips(carpeta, pre_v):
        # Una sola lectura de cabecera por fichero: abrirla dos veces para
        # sacar la duracion y luego el tamano seria pagar el doble por lo mismo.
        # One header read per file: opening it twice, once for the duration and
        # again for the size, would pay twice for the same thing.
        datos = _info(r)
        dur, cuantos, ancho, alto = datos[1], datos[2], datos[6], datos[7]
        try:
            cuando = int(os.path.getmtime(r))
        except OSError:
            cuando = 0
        salida.append({"n": n, "filename": os.path.basename(r), "subfolder": sub,
                       "segundos": round(float(dur), 2), "fotogramas": int(cuantos),
                       "ancho": int(ancho), "alto": int(alto), "mtime": cuando})
    return salida


def _montajes(path):
    """Los ficheros ya montados que existan, para el reproductor."""
    carpeta, base, _, _ = _nombres(path)
    if not os.path.isdir(carpeta):
        return []
    raiz = os.path.abspath(folder_paths.get_output_directory())
    sub = os.path.relpath(carpeta, raiz).replace("\\", "/")
    if sub == ".":
        sub = ""
    titulo = _titulo(carpeta, base)
    salida = []
    for etiqueta, sufijo in (("Video", "_final"), ("Interpolated", "_final_int")):
        f = "{}{}.mp4".format(titulo, sufijo)
        completo = os.path.join(carpeta, f)
        if os.path.exists(completo):
            salida.append({"label": etiqueta, "filename": f, "subfolder": sub,
                           "mb": round(os.path.getsize(completo) / 1048576.0, 1),
                           "mtime": int(os.path.getmtime(completo))})
    return salida


@PromptServer.instance.routes.get("/academia/moviola/arranque")
async def moviola_arranque(request):
    """El fotograma 0 de un clip, como PNG, sin dejar nada en el disco.

    Existe por la PRIMERA vuelta y solo por ella. Las demas ensenan el ultimo
    fotograma de la anterior, que ya esta guardado como `loop_#####.png`; la
    primera no tiene anterior, asi que hasta ahora ensenaba la imagen de
    referencia -- que no es de donde arranca -- o un hueco negro cuando la serie
    empezaba solo con el prompt.

    Se decodifica y se devuelve en la respuesta en vez de escribir un fichero:
    la carpeta del proyecto es del usuario y no debe llenarse de miniaturas que
    el no ha pedido. Y se manda el fotograma, no el clip entero, que para una
    tarjeta de cien pixeles seria bajarse varios megas.

    Frame 0 of a clip as a PNG, leaving nothing on disk. It exists for the FIRST
    take and only for it: every other card shows the previous take's last frame,
    already saved, while the first has no previous one and until now showed the
    reference image -- which is not where it starts -- or a black gap.

    Decoded and returned in the response rather than written out: the project
    folder belongs to the user and should not fill with thumbnails nobody asked
    for. And it sends the frame, not the whole clip, which for a hundred-pixel
    card would be several megabytes.
    """
    try:
        path = str(request.query.get("path") or "")
        n = int(request.query.get("n") or 1)
        carpeta, _, pre_v, _ = _nombres(path)
        elegido = None
        for num, ruta in _clips(carpeta, pre_v):
            if num == n:
                elegido = ruta
                break
        if elegido is None:
            return web.Response(status=404, text="no clip")
        fs = await _en_hilo(_fotogramas, elegido, 0, 1)
        if not fs:
            return web.Response(status=404, text="cannot decode")
        im = Image.fromarray(np.clip(fs[0], 0, 255).astype(np.uint8))
        # Se manda una miniatura, no el fotograma a tamano real: la tarjeta mide
        # unos cien pixeles y a todo zoom no pasa de trescientos, asi que un PNG
        # de 1280 de ancho serian mas de novecientos kilobytes para pintar algo
        # diez veces menor.
        # A thumbnail, not the full-size frame: the card is about a hundred pixels
        # and never past three hundred at full zoom, so a 1280-wide PNG would be
        # most of a megabyte to draw something ten times smaller.
        if im.width > ANCHO_MINIATURA:
            alto = max(1, round(im.height * ANCHO_MINIATURA / float(im.width)))
            im = im.resize((ANCHO_MINIATURA, alto), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return web.Response(body=buf.getvalue(), content_type="image/png",
                            headers={"Cache-Control": "no-cache"})
    except Exception as exc:
        return web.Response(status=400, text=str(exc))


@PromptServer.instance.routes.post("/academia/moviola/frames")
async def moviola_frames(request):
    try:
        datos = await request.json()
        path = _path_de(datos)
        return web.json_response({"status": "success",
                                  "frames": await _en_hilo(_frames, path),
                                  "clips": await _en_hilo(_vistas, path)})
    except Exception as exc:
        return web.json_response({"status": "error", "message": str(exc)}, status=400)


@PromptServer.instance.routes.post("/academia/moviola/folder")
async def moviola_folder(request):
    try:
        datos = await request.json()
        path = _path_de(datos)
        log = await _en_hilo(_carpeta, path)
        # Justo debajo de "Folder: ...", que es la linea que explica. Y el
        # listado se arma ANTES de abrir nada: si abrir falla, la respuesta
        # sigue trayendo lo que hay en la carpeta, que es lo util.
        # Right under "Folder: ...". The listing is built BEFORE opening
        # anything, so a failure to open still returns what is in there.
        log.insert(1, await _en_hilo(_abrir_carpeta, path))
        return web.json_response({
            "status": "success",
            "log": log,
            "finals": await _en_hilo(_montajes, path),
        })
    except Exception as exc:
        return web.json_response({"status": "error", "message": str(exc)}, status=400)


@PromptServer.instance.routes.post("/academia/moviola/edit")
async def moviola_edit(request):
    try:
        datos = await request.json()
        path = _path_de(datos)
        lf = int(datos.get("latent_frames") or 1)
        crf = max(0, min(51, int(datos.get("crf") or 18)))
        # -1, o ausente, significa medir. El `or` no vale aqui porque 0 es un
        # recorte legitimo: no recortar nada.
        # -1, or absent, means measure. `or` will not do, because 0 is a valid
        # trim: take nothing off.
        # En automatico los dos recortes fijos NI SE MIRAN. Se ignoran en vez de
        # borrarlos para que los valores de prueba sigan escritos en el nodo:
        # alternar entre medir y un corte fijo es un clic, no volver a teclear.
        #
        # In auto the two forced trims are NOT EVEN READ. They are ignored rather
        # than cleared so the values under test stay written in the node: moving
        # between measuring and a fixed cut is one click, not retyping.
        auto = bool(datos.get("auto_trim", True))

        def forzado(clave):
            if auto:
                return None
            crudo = datos.get(clave)
            return None if crudo is None else max(-1, min(64, int(crudo)))

        log, _ = await _en_hilo(_editar, path, lf, crf,
                                forzado("trim"), forzado("trim_int"),
                                bool(datos.get("deflicker", False)))
        log.append("")
        log.append(await _en_hilo(_informe, path, lf))
        return web.json_response({"status": "success", "log": log,
                                  "finals": await _en_hilo(_montajes, path)})
    except Exception as exc:
        return web.json_response({"status": "error", "message": str(exc)}, status=400)


@PromptServer.instance.routes.post("/academia/moviola/delete")
async def moviola_delete(request):
    try:
        datos = await request.json()
        path = _path_de(datos)
        todos = bool(datos.get("all"))
        log, _ = await _en_hilo(_borrar, path, todos)
        return web.json_response({"status": "success", "log": log,
                                  "finals": await _en_hilo(_montajes, path)})
    except Exception as exc:
        return web.json_response({"status": "error", "message": str(exc)}, status=400)


class AcademiaMoviola:
    """El montador: une las tomas del proyecto y deshace la ultima.

    No monta al ejecutarse. Unir diez clips son minutos de ffmpeg y no tiene
    nada que ver con generar: dispararlo en cada vuelta del bucle rehadria el
    montaje entero nueve veces para tirar ocho. Los botones lo lanzan cuando
    hace falta; ejecutar el nodo solo refresca el estado.

    It does not montage on execution. Joining ten clips is minutes of ffmpeg and
    has nothing to do with generating: firing it every pass would rebuild the
    whole cut nine times to throw eight away. The buttons run it on demand;
    executing the node only refreshes the status.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "path": ("STRING", {"default": "moviola/loop"}),
                "latent_frames": ("INT", {"default": 1, "min": 1, "max": 8, "step": 1,
                                          "tooltip": "Same value as Moviola Out. Only a "
                                                     "guide: it is used where a seam is too "
                                                     "still to measure."}),
                # ORDEN: los widgets NUEVOS van al FINAL de este diccionario.
                # ComfyUI guarda sus valores en un workflow como una lista
                # POSICIONAL, asi que meter uno en medio corre todos los de
                # detras y cada widget hereda el valor del vecino. Paso al meter
                # `deflicker` aqui: trim, trim_int y crf aparecieron cambiados en
                # un grafo ya guardado. Se queda donde esta porque moverlo ahora
                # volveria a descolocar los que ya se corrigieron a mano.
                #
                # ORDER: NEW widgets go at the END of this dict. ComfyUI stores
                # their values in a workflow as a POSITIONAL list, so inserting
                # one in the middle shifts everything after it and each widget
                # inherits its neighbour's value. It happened adding `deflicker`
                # here. It stays put because moving it now would shift again the
                # ones already corrected by hand.
                "deflicker": ("BOOLEAN", {"default": False, "label_on": "smooth",
                                          "label_off": "per clip",
                                          "tooltip": "Exposure correction. 'per clip' "
                                                     "matches each seam with one gain "
                                                     "per clip. 'smooth' corrects every "
                                                     "frame toward a smoothed brightness "
                                                     "curve, which also removes each "
                                                     "clip's own drift."}),
                "auto_trim": ("BOOLEAN", {"default": True, "label_on": "auto",
                                          "label_off": "fixed",
                                          "tooltip": "In auto every seam is measured "
                                                     "and the two trims below are "
                                                     "ignored, keeping their values for "
                                                     "when you switch back."}),
                "trim": ("INT", {"default": -1, "min": -1, "max": 64, "step": 1,
                                 "tooltip": "Plain track. -1 measures every seam, "
                                            "which is what you want. Any other value "
                                            "forces that many frames off every seam -- "
                                            "there to check the rule against a fixed "
                                            "cut."}),
                "trim_int": ("INT", {"default": -1, "min": -1, "max": 128, "step": 1,
                                     "tooltip": "Same, for the interpolated track, "
                                                "which needs its own number: "
                                                "interpolation inserts frames rather "
                                                "than duplicating them, so a trim of n "
                                                "here is 2n-1 -- 5 pairs with 9."}),
                "crf": ("INT", {"default": 18, "min": 0, "max": 51, "step": 1,
                                "tooltip": "x264 quality of the joined file. Raise it for a "
                                           "smaller file; 16 is near-transparent, 24 is "
                                           "about a third of the size."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "refrescar"
    CATEGORY = "Academia SD"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(s, **kwargs):
        return float("nan")

    # Los ajustes de montaje se ACEPTAN y no se usan. Ejecutar este nodo solo
    # refresca el estado; montar es cosa de los botones, que mandan estos mismos
    # valores por la ruta de API. Pero ComfyUI entrega TODA entrada declarada
    # como argumento, asi que una firma que no las nombre revienta el grafo -- y
    # no al pulsar un boton, sino en mitad de una serie.
    #
    # The montage settings are ACCEPTED and unused. Running this node only
    # refreshes state; joining belongs to the buttons, which send these same
    # values through the API route. But ComfyUI hands over every declared input
    # as an argument, so a signature that does not name them breaks the graph --
    # and not on a button press, but part-way through a series.
    def refrescar(self, path, latent_frames=1, deflicker=False, auto_trim=True,
                  trim=-1, trim_int=-1, crf=18, unique_id=None):
        try:
            texto = _informe(path, latent_frames)
        except Exception as exc:
            texto = "Error: {}".format(exc)
        print("[Moviola Editor v{}] {}".format(ACADEMIASD_VERSION, texto.replace("\n", " | ")))
        return {"ui": {"asd_moviola": [texto]}}


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MoviolaIn": AcademiaMoviolaIn,
    "AcademiaSD_MoviolaGuide": AcademiaMoviolaGuide,
    "AcademiaSD_MoviolaOut": AcademiaMoviolaOut,
    "AcademiaSD_Moviola": AcademiaMoviola,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MoviolaIn": "Academia SD Moviola In",
    "AcademiaSD_MoviolaGuide": "Academia SD Moviola Guide",
    "AcademiaSD_MoviolaOut": "Academia SD Moviola Out",
    "AcademiaSD_Moviola": "Academia SD Moviola 🎞️",
}

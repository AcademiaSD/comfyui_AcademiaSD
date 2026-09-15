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
import shutil
from fractions import Fraction

# PyAV, no un ffmpeg externo. Enlaza libavcodec/libavformat DENTRO del proceso,
# asi que aqui no se lanza ningun programa: se acabo el `subprocess` y, con el,
# la necesidad de que el usuario tenga ffmpeg instalado. `av>=17` es requisito
# del propio ComfyUI, no de un pack de terceros, asi que lo tiene todo el mundo.
#
# Antes esto pedia ffmpeg Y ffprobe. `imageio-ffmpeg`, que instala
# VideoHelperSuite, trae solo ffmpeg: quien no tuviera ffprobe en el sistema se
# quedaba sin montaje sin saber por que.
#
# PyAV rather than an external ffmpeg. It links libavcodec/libavformat INSIDE the
# process, so nothing is launched here: no subprocess, and no need for the user to
# have ffmpeg installed. `av>=17` is a requirement of ComfyUI itself.
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
    ACADEMIASD_VERSION = "2.4.5"

try:
    from safetensors.torch import load_file as _st_load
    from safetensors.torch import save_file as _st_save
except Exception:                                      # pragma: no cover
    _st_load = _st_save = None

# nombre_00001_.png
PATRON = r"^{}_(\d+)_?\.{}$"


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

    def servir(self, project_path, base_image=None):
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
        return {"ui": {"images": vista},
                "result": (imagen, n + 1, origen, project_path)}


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

    def anclar(self, positive, project_path, frame_idx=0, av_latent=None):
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

        # La geometria tiene que coincidir con el clip destino. Si cambias la
        # resolucion a mitad de bucle el keyframe no encaja, y el modelo falla lejos
        # de aqui con una traza que no menciona a Moviola.
        # The geometry has to match the target clip. Change resolution mid-loop and
        # the keyframe does not fit, and the model fails far from here with a
        # traceback that never mentions Moviola.
        if av_latent is not None:
            dest = av_latent["samples"]
            if getattr(dest, "is_nested", False):
                dest = dest.tensors[0]
            if dest.ndim == 5 and tuple(z.shape[3:]) != tuple(dest.shape[3:]):
                raise ValueError(
                    "[Moviola Guide] El fotograma guardado es {}x{} latente y el clip "
                    "destino {}x{}. Vacia la carpeta o vuelve a la resolucion anterior. "
                    "/ Saved frame is {}x{} in latent space and the target clip is "
                    "{}x{}. Empty the folder or go back to the previous resolution."
                    .format(z.shape[3], z.shape[4], dest.shape[3], dest.shape[4],
                            z.shape[3], z.shape[4], dest.shape[3], dest.shape[4]))

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

    def guardar(self, project_path, latent_frames=1, images=None, latent=None):
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
            ultimo = images[-1:]
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
        return (FPS_POR_DEFECTO, 0.0, 0, False, 0, 0)
    try:
        v = c.streams.video[0] if c.streams.video else None
        a = c.streams.audio[0] if c.streams.audio else None
        fps = float(v.average_rate) if v and v.average_rate else FPS_POR_DEFECTO
        dur = float(c.duration) / av.time_base if c.duration else 0.0
        n = int(v.frames or 0) if v else 0
        if not n and fps > 0 and dur:
            n = int(round(dur * fps))
        return (fps if fps > 1.0 else FPS_POR_DEFECTO, dur, n,
                a is not None, int(a.rate) if a else 0, int(a.channels) if a else 0)
    except Exception:
        return (FPS_POR_DEFECTO, 0.0, 0, False, 0, 0)
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
    fa = _ultimos_fotogramas(a, 2)
    fb = _fotogramas(b, 0, VENTANA_BUSQUEDA + 1)
    if len(fa) < 2 or len(fb) < 2:
        return None
    difs = [_dif(fa[1], x) for x in fb]
    k = min(range(len(difs)), key=lambda i: difs[i])
    mov = (_dif(fa[0], fa[1]) + _dif(fb[k], fb[min(k + 1, len(fb) - 1)])) / 2.0
    hombros = min(difs[0], difs[-1])
    return {"k": k, "dif": difs[k], "mov": mov,
            "clara": difs[k] < HUNDIMIENTO * hombros, "fa": fa, "fb": fb}


def _recorte_esperado(latent_frames, fps):
    """Cuanto rebobinado cabe esperar, en fotogramas del clip ya interpolado.

    Cada latente salvo la primera codifica cuatro fotogramas reales, y la
    interpolacion a 48 fps duplica. Es una GUIA: la medida manda, esto solo
    rescata las costuras donde no hay V que medir.
    """
    reales = max(1, int(latent_frames)) * FRAMES_POR_LATENTE
    return reales * 2 if fps > 36 else reales


def _decidir_recortes(perfiles, esperado):
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
    claras = sorted(p["k"] for p in perfiles if p and p["clara"])
    if claras:
        comun = claras[len(claras) // 2] + 1
    else:
        comun = max(1, int(esperado))
    return [((p["k"] + 1) if (p and p["clara"]) else comun) for p in perfiles]


def claras_hay(perfiles):
    return any(p and p["clara"] for p in perfiles)


def _medir(rutas, latent_frames, log):
    perfiles = [_perfil(rutas[i], rutas[i + 1], "s{}".format(i))
                for i in range(len(rutas) - 1)]
    esperado = _recorte_esperado(latent_frames, _fps(rutas[0]))
    recortes = _decidir_recortes(perfiles, esperado)

    salida = []
    for i, (p, n_rec) in enumerate(zip(perfiles, recortes)):
        if p is None:
            salida.append((n_rec, [1.0, 1.0, 1.0]))
            continue
        # La exposicion se mide contra el fotograma que SOBREVIVE al recorte. Con
        # ocho descartados, medirla contra el 0 calcula la ganancia de una imagen
        # que se tira y el cambio de tono sobrevive a la correccion.
        sup = p["fb"][min(n_rec, len(p["fb"]) - 1)]
        salida.append((n_rec, _ganancia(p["fa"][1], sup)))
        log.append("   seam {} -> {}   dip at {}{}   trim {}".format(
            i + 1, i + 2, p["k"], "" if p["clara"] else " (flat, copied)", n_rec))
    if perfiles and not claras_hay(perfiles):
        log.append("   no clear dip anywhere: fell back to latent_frames "
                   "({} frames)".format(esperado))
    return salida


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

def _montar(rutas, destino, latent_frames, crf, log):
    """Une los clips corrigiendo las tres costuras, sin salir del proceso."""
    dec = _medir(rutas, latent_frames, log)
    recorta = [0] + [d[0] for d in dec]

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
        for i, r in enumerate(rutas):
            g = gan[i]
            toca = max(abs(x - 1.0) for x in g) >= 0.005
            c = _abrir(r)
            if c is None:
                continue
            try:
                v = c.streams.video[0]
                v.thread_type = "AUTO"
                for idx, f in enumerate(c.decode(v)):
                    if idx < recorta[i]:
                        continue
                    if toca:
                        arr = f.to_ndarray(format="rgb24").astype(np.float32)
                        arr[..., 0] *= g[0]
                        arr[..., 1] *= g[1]
                        arr[..., 2] *= g[2]
                        f = av.VideoFrame.from_ndarray(
                            np.clip(arr, 0, 255).astype(np.uint8), format="rgb24")
                    else:
                        f = av.VideoFrame.from_ndarray(
                            f.to_ndarray(format="rgb24"), format="rgb24")
                    f.pts = escritos
                    f.time_base = base_t
                    escritos += 1
                    for p in vo.encode(f):
                        sal.mux(p)
            finally:
                c.close()
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


def _editar(path, latent_frames, crf):
    """Une los clips de cada pista. Devuelve las lineas de consola."""
    log = []
    carpeta, base, pre_v, pre_i = _nombres(path)
    titulo = _titulo(carpeta, base)
    hecho = []
    for etiqueta, prefijo, sufijo in (("video", pre_v, "_final"),
                                      ("interpolated", pre_i, "_final_int")):
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
            _montar(rutas, destino, latent_frames, crf, log)
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

    queda = _estado(path)["loop"]
    if quitados == 0:
        log.append("No loops to delete.")
    log.append("Current loop: {}".format(queda))
    if queda == 0:
        log.append("The project is empty: the next take starts from the base image.")
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
            salida.append({"n": int(m.group(1)), "filename": f, "subfolder": sub})
    salida.sort(key=lambda x: x["n"])
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


@PromptServer.instance.routes.post("/academia/moviola/frames")
async def moviola_frames(request):
    try:
        datos = await request.json()
        return web.json_response({"status": "success",
                                  "frames": await _en_hilo(_frames, _path_de(datos))})
    except Exception as exc:
        return web.json_response({"status": "error", "message": str(exc)}, status=400)


@PromptServer.instance.routes.post("/academia/moviola/edit")
async def moviola_edit(request):
    try:
        datos = await request.json()
        path = _path_de(datos)
        lf = int(datos.get("latent_frames") or 1)
        crf = max(0, min(51, int(datos.get("crf") or 18)))
        log, _ = await _en_hilo(_editar, path, lf, crf)
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

    def refrescar(self, path, latent_frames=1, crf=18, unique_id=None):
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

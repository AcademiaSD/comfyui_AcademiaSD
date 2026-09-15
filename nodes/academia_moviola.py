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

import os
import re

import numpy as np
import torch
from PIL import Image

import folder_paths
import node_helpers

try:
    from .. import __version__ as ACADEMIASD_VERSION
except Exception:
    ACADEMIASD_VERSION = "2.4.0"

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
                raise ValueError(
                    "[Moviola In] Primera vuelta: no hay fotogramas en '{}' y falta "
                    "base_image. / First pass: no frames in '{}' and base_image is "
                    "missing.".format(carpeta, carpeta))
            imagen = base_image
            origen = "base"
            print("[Moviola In v{}] carpeta vacia, sirviendo la base "
                  "/ empty folder, serving the base".format(ACADEMIASD_VERSION))
        else:
            img = Image.open(fichero).convert("RGB")
            imagen = torch.from_numpy(np.array(img).astype(np.float32) / 255.0).unsqueeze(0)
            origen = os.path.basename(fichero)
            print("[Moviola In v{}] sirviendo {} / serving {}".format(
                ACADEMIASD_VERSION, origen, origen))

        return {"ui": {"images": _vista_previa(imagen, nombre + "_in")},
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

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)
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
        return {"ui": {"images": ui}, "result": (base,)}


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MoviolaIn": AcademiaMoviolaIn,
    "AcademiaSD_MoviolaGuide": AcademiaMoviolaGuide,
    "AcademiaSD_MoviolaOut": AcademiaMoviolaOut,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MoviolaIn": "Academia SD Moviola In",
    "AcademiaSD_MoviolaGuide": "Academia SD Moviola Guide",
    "AcademiaSD_MoviolaOut": "Academia SD Moviola Out",
}

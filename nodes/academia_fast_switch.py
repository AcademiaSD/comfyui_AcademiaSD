"""Academia SD Fast Switch.

Dos nodos que trabajan en pareja:

  * Fast Switch · Models   dos ranuras, A y B, del mismo directorio de modelos.
                           Saca por la salida el fichero de la ranura activa,
                           para enchufarlo al unet_name de un Load Diffusion
                           Model (o al lora_name de un LoraLoader, etc).
  * Fast Switch · Toggle   un interruptor A/B que enciende unos grupos y pasa
                           por bypass los otros, y de paso mueve la ranura de
                           todos los nodos Models del grafo, esten conectados
                           o no.

La salida de Models es de tipo comodin a proposito. El validador de ComfyUI
acepta el comodin contra cualquier entrada (comfy_execution/validation.py), y
asi el mismo nodo vale para diffusion_models, loras, vae, clip o lo que pongas
en la ruta, sin tener que declarar un tipo distinto por carpeta.
"""

import json
import os
import sys

import folder_paths
from aiohttp import web
from server import PromptServer


def _academiasd_version():
    try:
        from .. import __version__ as v
        return v
    except Exception:
        pass
    for name in ("comfyui_AcademiaSD", "comfyui_academiasd", "custom_nodes.comfyui_AcademiaSD"):
        v = getattr(sys.modules.get(name), "__version__", None)
        if v:
            return v
    return "?"


ACADEMIASD_VERSION = _academiasd_version()

MODEL_EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".sft",
              ".gguf", ".onnx", ".engine", ".pkl")


class _AnyType(str):
    """Tipo comodin al uso: nunca es distinto de nada, asi que enlaza con todo."""

    def __ne__(self, other):
        return False


ANY = _AnyType("*")


# --------------------------------------------------------------- carpetas

def known_folders():
    """Las carpetas que ComfyUI ya conoce, en formato 'models/<clave>'."""
    try:
        keys = sorted(folder_paths.folder_names_and_paths.keys())
    except Exception:
        keys = []
    return ["models/{}".format(k) for k in keys]


def _folder_key(spec):
    """'models\\diffusion_models' -> 'diffusion_models' si ComfyUI la conoce."""
    s = str(spec or "").replace("\\", "/").strip().strip("/")
    if not s:
        return None, ""
    candidates = [s]
    if s.lower().startswith("models/"):
        candidates.append(s[len("models/"):])
    for c in candidates:
        try:
            if c in folder_paths.folder_names_and_paths:
                return c, s
        except Exception:
            pass
    return None, s


def list_models(spec):
    """Ficheros de la carpeta pedida. Devuelve (lista, como_se_resolvio, error)."""
    key, cleaned = _folder_key(spec)
    if key:
        try:
            return list(folder_paths.get_filename_list(key)), "folder_paths:" + key, None
        except Exception as e:
            return [], "folder_paths:" + key, str(e)

    # Ruta escrita a mano que ComfyUI no tiene registrada: se recorre a pelo,
    # relativa a la raiz de ComfyUI si no es absoluta.
    root = cleaned
    if not os.path.isabs(root):
        try:
            root = os.path.join(folder_paths.base_path, cleaned)
        except Exception:
            root = os.path.abspath(cleaned)
    if not os.path.isdir(root):
        return [], root, "Directory not found: {}".format(root)

    out = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if name.lower().endswith(MODEL_EXTS):
                rel = os.path.relpath(os.path.join(dirpath, name), root)
                out.append(rel.replace("\\", "/"))
    out.sort()
    return out, root, None


@PromptServer.instance.routes.get("/academia/fastswitch/folders")
async def _fastswitch_folders(request):
    return web.json_response({"folders": known_folders()})


@PromptServer.instance.routes.post("/academia/fastswitch/files")
async def _fastswitch_files(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    files, resolved, error = list_models(data.get("folder"))
    return web.json_response({"files": files, "resolved": resolved, "error": error})


# ------------------------------------------------------------------ estado

def _parse(switch_data):
    try:
        data = json.loads(switch_data) if switch_data else {}
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _side(data):
    return "b" if str(data.get("side", "a")).lower() == "b" else "a"


def _labels(data):
    lab = data.get("labels") or {}
    return (str(lab.get("a") or "A"), str(lab.get("b") or "B"))


# ------------------------------------------------------------------- nodos

class AcademiaFastSwitchModels:
    """Ranura A / ranura B del mismo directorio; sale la que este activa."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "switch_data": ("STRING", {
                    "default": "{}",
                    "multiline": False,
                    "tooltip": "Serialized state of the switch. Managed by the node UI.",
                }),
            },
        }

    RETURN_TYPES = (ANY, "STRING")
    RETURN_NAMES = ("model_name", "label")
    FUNCTION = "run"
    CATEGORY = "AcademiaSD/Switch"
    DESCRIPTION = ("Two model slots, A and B, from the same models folder. "
                   "Outputs the active one — plug it into unet_name, lora_name, "
                   "ckpt_name… The A/B side follows the Fast Switch Toggle.")

    @classmethod
    def IS_CHANGED(cls, switch_data="{}", **kwargs):
        return switch_data

    def run(self, switch_data="{}", **kwargs):
        data = _parse(switch_data)
        side = _side(data)
        label_a, label_b = _labels(data)

        chosen = str(data.get(side) or "")
        label = label_a if side == "a" else label_b
        folder = data.get("folder") or "models/diffusion_models"

        if not chosen:
            raise ValueError(
                "Academia Fast Switch: slot {} (\"{}\") has no model selected. "
                "Pick one in the node, or flip the switch to the other side."
                .format(side.upper(), label)
            )

        # Se avisa, pero no se corta: puede que el otro lado aun no este puesto
        # y el usuario solo quiera trabajar con este.
        other = "b" if side == "a" else "a"
        if not str(data.get(other) or ""):
            print("[Fast Switch v{}] warning: slot {} is still empty"
                  .format(ACADEMIASD_VERSION, other.upper()))

        print("[Fast Switch v{}] {} -> {}  ({})"
              .format(ACADEMIASD_VERSION, label, chosen, folder))
        return (chosen, label)


class AcademiaFastSwitchToggle:
    """El interruptor. Todo lo que hace de verdad ocurre en el navegador."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "switch_data": ("STRING", {
                    "default": "{}",
                    "multiline": False,
                    "tooltip": "Serialized state of the switch. Managed by the node UI.",
                }),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = False
    CATEGORY = "AcademiaSD/Switch"
    DESCRIPTION = ("A physical A/B switch: enables one set of groups, bypasses "
                   "the other, and moves every Fast Switch Models node in the "
                   "graph — connected or not.")

    @classmethod
    def IS_CHANGED(cls, switch_data="{}", **kwargs):
        return switch_data

    def run(self, switch_data="{}", **kwargs):
        data = _parse(switch_data)
        side = _side(data)
        label_a, label_b = _labels(data)
        print("[Fast Switch v{}] toggle on {}"
              .format(ACADEMIASD_VERSION, label_a if side == "a" else label_b))
        return ()


NODE_CLASS_MAPPINGS = {
    "Academia_Fast_Switch_Models": AcademiaFastSwitchModels,
    "Academia_Fast_Switch_Toggle": AcademiaFastSwitchToggle,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Academia_Fast_Switch_Models": "Academia SD Fast Switch · Models 🅰️🅱️",
    "Academia_Fast_Switch_Toggle": "Academia SD Fast Switch · Toggle 🎚️",
}

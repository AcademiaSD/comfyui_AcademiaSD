import os
import torch
import gc
from huggingface_hub import snapshot_download
# Importamos la clase correcta, si falla en versiones viejas usamos el alias
try:
    from transformers import AutoModelForImageTextToText as AutoModelForVision2Seq
except ImportError:
    from transformers import AutoModelForVision2Seq
from transformers import AutoProcessor, BitsAndBytesConfig

loaded_data = {"model": None, "processor": None, "path": None}

_VISION_DIR = os.path.join(
    os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "models", "vision")
_FLAG_REMOTE_CODE = os.path.join(_VISION_DIR, "allow_remote_code.flag")


def _remote_code_permitido():
    """Si se permite ejecutar el codigo que venga dentro del repo del modelo.

    transformers ejecuta Python del propio repo cuando trust_remote_code=True. Como
    repo_id sale de un widget, cualquiera que alcance /prompt podria apuntar a un
    repo suyo y ejecutar lo que quisiera en la maquina del usuario.

    El permiso NO puede ser un widget del nodo: quien envia el /prompt controla
    todos los widgets y lo activaria el mismo. Tiene que vivir donde solo llegue
    quien tenga acceso a la maquina: una variable de entorno o un fichero en disco.
    """
    if os.environ.get("ACADEMIASD_ALLOW_REMOTE_CODE", "").strip().lower() in ("1", "true", "yes", "on"):
        return True
    return os.path.exists(_FLAG_REMOTE_CODE)


_AVISO_REMOTE_CODE = (
    "[AcademiaSD] El modelo '{repo}' pide ejecutar codigo incluido en su propio "
    "repositorio (trust_remote_code).\n"
    "Esta desactivado por seguridad: quien alcance el puerto de ComfyUI podria "
    "cargar un repositorio malicioso y ejecutar codigo en tu equipo.\n"
    "Si confias en ese modelo, activalo de una de estas dos formas:\n"
    "  - crea el fichero: {flag}\n"
    "  - o arranca ComfyUI con la variable ACADEMIASD_ALLOW_REMOTE_CODE=1"
)

class AcademiaModelLoader:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "repo_id": ("STRING", {"default": "Qwen/Qwen2-VL-2B-Instruct"}),
                "low_vram": (["enable", "disable"], {"default": "enable"}),
            },
            "optional": {
                # Vacio = rama main, que es lo que se venia haciendo. Poner aqui el
                # hash de un commit fija esa version exacta: una rama puede cambiar
                # de contenido sin avisar, un commit no.
                "revision": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Optional. Commit hash (or tag) to pin the download. "
                               "Leave empty to use the main branch.",
                }),
            },
        }

    RETURN_TYPES = ("ACADEMIA_MODEL",)
    RETURN_NAMES = ("MODEL",)
    FUNCTION = "load_model"
    CATEGORY = "AcademiaSD"

    def load_model(self, repo_id, low_vram, revision=""):
        revision = (revision or "").strip()

        # 1. Rutas (Igual que antes pero más robusto)
        current_dir = os.path.dirname(os.path.realpath(__file__))
        # El nombre de carpeta sale del repo_id, asi que solo dejamos pasar
        # caracteres inocuos: un "..\\.." en el campo saldria del directorio.
        nombre = "".join(c if (c.isalnum() or c in "._-") else "_" for c in repo_id)
        if revision:
            # Cada revision en su propia carpeta. Sin esto, fijar un commit
            # reutilizaria la descarga anterior y no se traeria nada nuevo.
            sufijo = "".join(c if (c.isalnum() or c in "._-") else "_" for c in revision)
            nombre = f"{nombre}@{sufijo[:20]}"
        target_dir = os.path.join(current_dir, "..", "..", "..", "models", "vision", nombre)

        if not os.path.exists(target_dir):
            print(f"[AcademiaSD] Descargando {repo_id} ({revision or 'main'})...")
            snapshot_download(repo_id=repo_id, revision=revision or "main",
                              local_dir=target_dir, local_dir_use_symlinks=False)

        if loaded_data["path"] == target_dir:
            return (loaded_data,)

        if loaded_data["model"] is not None:
            del loaded_data["model"]
            torch.cuda.empty_cache()
            gc.collect()

        print(f"[AcademiaSD] Cargando modelo: {repo_id}")
        
        # Configuración para cargar bien modelos como Qwen3
        quant_config = None
        if low_vram == "enable":
            quant_config = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16)

        permitir_codigo = _remote_code_permitido()

        try:
            # target_dir es una carpeta local ya descargada, no un repo remoto:
            # aqui no hay revision que fijar.
            loaded_data["model"] = AutoModelForVision2Seq.from_pretrained(  # nosec B615
                target_dir,
                torch_dtype=torch.float16,
                device_map="auto",
                trust_remote_code=permitir_codigo,
                quantization_config=quant_config
            ).eval()

            loaded_data["processor"] = AutoProcessor.from_pretrained(  # nosec B615
                target_dir, trust_remote_code=permitir_codigo)
        except Exception as e:
            if not permitir_codigo:
                # transformers pide trust_remote_code cuando el repo trae su propio
                # codigo de modelado. Explicamos como habilitarlo en vez de soltar
                # el error crudo, que no dice como salir del paso.
                aviso = _AVISO_REMOTE_CODE.format(
                    repo=repo_id, flag=os.path.abspath(_FLAG_REMOTE_CODE))
                print(aviso)
                raise RuntimeError(aviso) from e
            raise

        loaded_data["path"] = target_dir

        return (loaded_data,)

NODE_CLASS_MAPPINGS = {"AcademiaModelLoader": AcademiaModelLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"AcademiaModelLoader": "AcademiaSD VLModel (Down)Loader"}
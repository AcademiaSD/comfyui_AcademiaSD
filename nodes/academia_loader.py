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

        # target_dir es una carpeta local ya descargada, no un repo remoto:
        # aqui no hay revision que fijar.
        loaded_data["model"] = AutoModelForVision2Seq.from_pretrained(  # nosec B615 - ruta local
            target_dir,
            torch_dtype=torch.float16,
            device_map="auto",
            trust_remote_code=True,
            quantization_config=quant_config
        ).eval()

        loaded_data["processor"] = AutoProcessor.from_pretrained(target_dir, trust_remote_code=True)  # nosec B615
        loaded_data["path"] = target_dir
        
        return (loaded_data,)

NODE_CLASS_MAPPINGS = {"AcademiaModelLoader": AcademiaModelLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"AcademiaModelLoader": "AcademiaSD VLModel (Down)Loader"}
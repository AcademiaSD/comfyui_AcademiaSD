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
        }

    RETURN_TYPES = ("ACADEMIA_MODEL",)
    RETURN_NAMES = ("MODEL",)
    FUNCTION = "load_model"
    CATEGORY = "AcademiaSD"

    def load_model(self, repo_id, low_vram):
        # 1. Rutas (Igual que antes pero más robusto)
        current_dir = os.path.dirname(os.path.realpath(__file__))
        target_dir = os.path.join(current_dir, "..", "..", "..", "models", "vision", repo_id.replace("/", "_"))
        
        if not os.path.exists(target_dir):
            print(f"[AcademiaSD] Descargando {repo_id}...")
            snapshot_download(repo_id=repo_id, local_dir=target_dir, local_dir_use_symlinks=False)

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

        loaded_data["model"] = AutoModelForVision2Seq.from_pretrained(
            target_dir,
            torch_dtype=torch.float16,
            device_map="auto",
            trust_remote_code=True,
            quantization_config=quant_config
        ).eval()
        
        loaded_data["processor"] = AutoProcessor.from_pretrained(target_dir, trust_remote_code=True)
        loaded_data["path"] = target_dir
        
        return (loaded_data,)

NODE_CLASS_MAPPINGS = {"AcademiaModelLoader": AcademiaModelLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"AcademiaModelLoader": "AcademiaSD VLModel (Down)Loader"}
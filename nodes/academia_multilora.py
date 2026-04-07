import os
import json
import comfy.sd
import comfy.utils
import folder_paths
from server import PromptServer
from aiohttp import web

@PromptServer.instance.routes.get("/academia/lora_list")
async def get_lora_list(request):
    loras = folder_paths.get_filename_list("loras")
    return web.json_response(loras)

class AcademiaMultiLoraNode:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL",),
                "injection_method": (["Standard (Native)", "Model Only (No CLIP)"],),
                "lora_data": ("STRING", {"default": "[]"}),
            },
            # Hacemos que el CLIP sea totalmente OPCIONAL
            "optional": {
                "clip": ("CLIP", {"default": None}),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "apply_loras"
    CATEGORY = "Academia SD"

    def apply_loras(self, model, injection_method, lora_data="[]", clip=None):
        try:
            loras = json.loads(lora_data)
        except:
            loras = []

        # Si no hay loras o la lista está vacía, devolvemos las cosas tal cual
        if not loras:
            return (model, clip)

        print(f"[AcademiaSD] Starting Multi-LoRA Injection...")

        for lora in loras:
            if not lora.get("enabled", True):
                continue

            lora_name = lora.get("name")
            if not lora_name or lora_name == "None":
                continue

            strength = float(lora.get("strength", 1.0))
            
            if strength == 0.0:
                print(f"[AcademiaSD] ⏩ Skipping: {lora_name} (Strength is 0)")
                continue

            lora_path = folder_paths.get_full_path("loras", lora_name)
            
            if not lora_path:
                print(f"[AcademiaSD] ❌ Warning: Could not find LoRA file: {lora_name}")
                continue

            print(f"[AcademiaSD] 💉 Injecting: {lora_name} (Strength: {strength})")
            
            try:
                lora_tensor = comfy.utils.load_torch_file(lora_path, safe_load=True)
            except Exception as e:
                print(f"[AcademiaSD] ❌ Error loading LoRA data for {lora_name}: {e}")
                continue
            
            # Ajustar potencias
            strength_model = strength
            # Si no hay clip conectado o elegiste "Model Only", no se inyecta nada al CLIP
            strength_clip = strength if (injection_method == "Standard (Native)" and clip is not None) else 0.0
            
            lora_model, lora_clip = comfy.sd.load_lora_for_models(
                model, clip, lora_tensor, strength_model, strength_clip
            )
            
            if lora_model is not None:
                model = lora_model
            # Solo actualizar clip si realmente teníamos un clip conectado inicialmente
            if lora_clip is not None and clip is not None:
                clip = lora_clip

        return (model, clip)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MultiLora": AcademiaMultiLoraNode
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MultiLora": "Academia SD Multi-LoRA 💊"
}
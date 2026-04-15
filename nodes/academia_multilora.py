import os
import json
import struct
import comfy.sd
import comfy.utils
import folder_paths
from server import PromptServer
from aiohttp import web
import asyncio

# --- NUEVA API: Leer Metadatos del LoRA en milisegundos ---
def read_lora_metadata(lora_path):
    if not lora_path or not os.path.exists(lora_path):
        return "File not found."
    if not lora_path.endswith(".safetensors"):
        return "Metadata reading is only supported for .safetensors files."

    try:
        with open(lora_path, "rb") as f:
            # Los primeros 8 bytes de un safetensors indican el tamaño del JSON del header
            header_size = struct.unpack("<Q", f.read(8))[0]
            # Leemos el JSON (esto es instantáneo, no carga los pesos del modelo)
            header_json = f.read(header_size).decode("utf-8")
            header = json.loads(header_json)
            
            metadata = header.get("__metadata__", {})
            if not metadata:
                return "No training metadata found in this LoRA."
            
            output = []
            
            # Modelo Base
            base_model = metadata.get("ss_sd_model_name", metadata.get("ss_base_model_version", ""))
            if base_model:
                output.append(f"🧠 Base Model: {base_model}")
                
            # Resolución
            res = metadata.get("ss_resolution", "")
            if res:
                output.append(f"📐 Resolution: {res}")
                
            # Extraer Tags / Trigger Words (Kohya / OneTrainer format)
            tag_freq = metadata.get("ss_tag_frequency", "")
            tags_dict = {}
            if tag_freq:
                try:
                    tf = json.loads(tag_freq)
                    for ds, ds_tags in tf.items():
                        for tag, count in ds_tags.items():
                            tags_dict[tag] = tags_dict.get(tag, 0) + count
                except:
                    pass
            
            # Formato alternativo de trigger words (Civitai/ModelSpec)
            alt_triggers = metadata.get("modelspec.trigger_words", metadata.get("ss_tag_frequency_0", ""))
            if alt_triggers and not tags_dict:
                output.append(f"\n🏷️ Triggers:\n{alt_triggers}")
            
            # Si extrajimos los tags correctamente, mostrar los Top 15
            if tags_dict:
                sorted_tags = sorted(tags_dict.items(), key=lambda x: x[1], reverse=True)
                # Filtramos los top 15 para no saturar la pantalla
                top_tags = [f"{t}" for t, c in sorted_tags[:15]]
                output.append("\n🏷️ Top Training Tags:\n" + ", ".join(top_tags))
            
            if not output:
                return "Metadata exists, but no tags or model info were found."

            return "\n".join(output)

    except Exception as e:
        return f"Error reading metadata: {str(e)}"

@PromptServer.instance.routes.post("/academia/lora_info")
async def get_lora_info(request):
    data = await request.json()
    lora_name = data.get("name")
    if not lora_name or lora_name == "None":
        return web.json_response({"info": "No LoRA selected."})

    lora_path = folder_paths.get_full_path("loras", lora_name)
    # Lo ejecutamos en segundo plano para no bloquear ComfyUI
    info = await asyncio.to_thread(read_lora_metadata, lora_path)
    return web.json_response({"info": info})

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
            
            strength_model = strength
            strength_clip = strength if (injection_method == "Standard (Native)" and clip is not None) else 0.0
            
            lora_model, lora_clip = comfy.sd.load_lora_for_models(
                model, clip, lora_tensor, strength_model, strength_clip
            )
            
            if lora_model is not None:
                model = lora_model
            if lora_clip is not None and clip is not None:
                clip = lora_clip

        return (model, clip)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MultiLora": AcademiaMultiLoraNode
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MultiLora": "Academia SD Multi-LoRA 💊"
}
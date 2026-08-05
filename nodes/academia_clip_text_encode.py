import os
import json
import folder_paths
from server import PromptServer
from aiohttp import web

# Directorio de almacenamiento de prompts dentro del nodo custom
PROMPT_LISTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "prompt_lists")
os.makedirs(PROMPT_LISTS_DIR, exist_ok=True)

# Creación de plantillas vacías por defecto si no existen
for default_file in ["default_positive_prompt.json", "default_negative_prompt.json"]:
    file_path = os.path.join(PROMPT_LISTS_DIR, default_file)
    if not os.path.exists(file_path):
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump({"favorites": [], "recents": []}, f, indent=4)

# --- RUTAS DE API ---
@PromptServer.instance.routes.get("/academia/prompts/list")
async def list_prompt_files(request):
    try:
        files = [f[:-5] for f in os.listdir(PROMPT_LISTS_DIR) if f.endswith(".json")]
        return web.json_response({"status": "success", "files": sorted(files)})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})

@PromptServer.instance.routes.get("/academia/prompts/load")
async def load_prompt_file(request):
    name = request.query.get("name")
    if not name:
        return web.json_response({"status": "error", "message": "No name provided"})
    
    file_path = os.path.join(PROMPT_LISTS_DIR, f"{name}.json")
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return web.json_response({"status": "success", "data": json.load(f)})
        except Exception as e:
            return web.json_response({"status": "error", "message": str(e)})
    return web.json_response({"status": "success", "data": {"favorites": [], "recents": []}})

@PromptServer.instance.routes.post("/academia/prompts/save")
async def save_prompt_file(request):
    try:
        data = await request.json()
        name = data.get("name")
        content = data.get("data", {"favorites": [], "recents": []})
        if not name:
            return web.json_response({"status": "error", "message": "No name provided"})
        
        # Sanitizar nombre de archivo
        safe_name = "".join(c for c in name if c.isalnum() or c in (' ', '-', '_')).rstrip()
        file_path = os.path.join(PROMPT_LISTS_DIR, f"{safe_name}.json")
        
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(content, f, indent=4)
        return web.json_response({"status": "success"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})

@PromptServer.instance.routes.delete("/academia/prompts/delete")
async def delete_prompt_file(request):
    try:
        name = request.query.get("name")
        if not name or "default_positive" in name or "default_negative" in name:
            return web.json_response({"status": "error", "message": "Cannot delete default templates"})
        
        file_path = os.path.join(PROMPT_LISTS_DIR, f"{name}.json")
        if os.path.exists(file_path):
            os.remove(file_path)
            return web.json_response({"status": "success"})
        return web.json_response({"status": "error", "message": "File not found"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


# --- CLASE BASE DEL NODO ---
class AcademiaCLIPTextEncode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "text": ("STRING", {"multiline": True}),
                "clip": ("CLIP", ),
            }
        }
    
    # 1. Definimos los tipos de salida (Añadido "STRING")
    RETURN_TYPES = ("CONDITIONING", "STRING")
    # 2. Asignamos nombres visibles a las salidas
    RETURN_NAMES = ("CONDITIONING", "STRING")
    
    FUNCTION = "encode"
    CATEGORY = "Academia SD/Conditioning"

    def encode(self, clip, text):
        # Mapeo idéntico al codificador nativo de ComfyUI
        tokens = clip.tokenize(text)
        cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
        
        # 3. Devolvemos el acondicionado junto con el texto plano en formato STRING
        return ([[cond, {"pooled_output": pooled}]], text)


class AcademiaPositivePromptNode(AcademiaCLIPTextEncode):
    pass

class AcademiaNegativePromptNode(AcademiaCLIPTextEncode):
    pass

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_PositivePrompt": AcademiaPositivePromptNode,
    "AcademiaSD_NegativePrompt": AcademiaNegativePromptNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_PositivePrompt": "Academia SD CLIP Text Encode (Positive) 🟢",
    "AcademiaSD_NegativePrompt": "Academia SD CLIP Text Encode (Negative) 🔴"
}
import os
import json
import folder_paths
from server import PromptServer
from aiohttp import web

# Directorio de almacenamiento de prompts dentro del nodo custom
PROMPT_LISTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "prompt_lists")
os.makedirs(PROMPT_LISTS_DIR, exist_ok=True)


def _prompt_path(name):
    """Ruta de <name>.json dentro de PROMPT_LISTS_DIR.

    Devuelve None si el nombre intenta salirse del directorio: estas rutas son
    alcanzables por cualquiera que llegue al puerto de ComfyUI, así que el
    nombre nunca puede elegir un fichero arbitrario del disco.
    """
    if not name:
        return None
    base = os.path.abspath(PROMPT_LISTS_DIR)
    destino = os.path.abspath(os.path.join(base, f"{name}.json"))
    if os.path.commonpath([base, destino]) != base:
        return None
    return destino


# Creación de plantillas vacías por defecto si no existen
for default_file in ["default_positive_prompt.json", "default_negative_prompt.json"]:
    file_path = os.path.join(PROMPT_LISTS_DIR, default_file)
    if not os.path.exists(file_path):
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"favorites": [], "recents": []}, indent=4))

# --- RUTAS DE API ---
@PromptServer.instance.routes.get("/academia/prompts/list")
async def list_prompt_files(request):
    try:
        files = [f[:-5] for f in os.listdir(PROMPT_LISTS_DIR) if f.endswith(".json")]
        return web.json_response({"status": "success", "files": sorted(files)})
    except Exception:
        return web.json_response({"status": "error", "message": "Could not list the prompt files"}, status=400)

@PromptServer.instance.routes.get("/academia/prompts/load")
async def load_prompt_file(request):
    name = request.query.get("name")
    if not name:
        return web.json_response({"status": "error", "message": "No name provided"})

    file_path = _prompt_path(name)
    if file_path is None:
        return web.json_response({"status": "error", "message": "Invalid name"}, status=400)

    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return web.json_response({"status": "success", "data": json.load(f)})
        except Exception:
            return web.json_response({"status": "error", "message": "Could not read the prompt list"}, status=400)
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
            f.write(json.dumps(content, indent=4))
        return web.json_response({"status": "success"})
    except Exception:
        return web.json_response({"status": "error", "message": "Could not save the prompt list"}, status=400)

@PromptServer.instance.routes.delete("/academia/prompts/delete")
async def delete_prompt_file(request):
    try:
        name = request.query.get("name")
        if not name or "default_positive" in name or "default_negative" in name:
            return web.json_response({"status": "error", "message": "Cannot delete default templates"})

        file_path = _prompt_path(name)
        if file_path is None:
            return web.json_response({"status": "error", "message": "Invalid name"}, status=400)

        if os.path.exists(file_path):
            os.remove(file_path)
            return web.json_response({"status": "success"})
        return web.json_response({"status": "error", "message": "File not found"})
    except Exception:
        return web.json_response({"status": "error", "message": "Could not delete the prompt list"}, status=400)


# --- CLASE BASE DEL NODO ---
class AcademiaCLIPTextEncode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "text": ("STRING", {"multiline": True}),
                "clip": ("CLIP", ),
            },
            # `prompt` es un ZÓCALO puro (`forceInput`), no un segundo widget: el
            # nodo ya tiene su caja con historial y favoritos, y otra caja en el
            # mismo papel solo plantearía la duda de cuál manda. Conectado gana
            # él; desconectado no existe y el nodo funciona como siempre.
            #
            # `prompt` is a CONNECTOR only (`forceInput`), not a second widget: the
            # node already has its box with history and favourites, and another
            # box in the same role would only raise the question of which wins.
            "optional": {
                "prompt": ("STRING", {"forceInput": True}),
            },
        }

    # 1. Definimos los tipos de salida (Añadido "STRING")
    RETURN_TYPES = ("CONDITIONING", "STRING")
    # 2. Asignamos nombres visibles a las salidas
    RETURN_NAMES = ("CONDITIONING", "STRING")

    FUNCTION = "encode"
    CATEGORY = "Academia SD/Conditioning"

    def encode(self, clip, text, prompt=None):
        # Un prompt externo sustituye a la caja. La cadena VACÍA cuenta como
        # valor legítimo: quien conecta un Multi-Prompt sin nada escrito quiere
        # un vacío, no que reaparezca sin avisar lo que quedó en la caja. Solo un
        # `prompt` DESCONECTADO (None) devuelve el mando al widget.
        #
        # An external prompt replaces the box. The empty string counts as a real
        # value: wiring a Multi-Prompt with nothing written means empty, not a
        # silent fallback to whatever the box still holds. Only a DISCONNECTED
        # `prompt` (None) hands control back to the widget.
        efectivo = text if prompt is None else str(prompt)

        # Mapeo idéntico al codificador nativo de ComfyUI
        tokens = clip.tokenize(efectivo)
        cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)

        # 3. Devolvemos el acondicionado junto con el texto plano en formato STRING
        return ([[cond, {"pooled_output": pooled}]], efectivo)


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
import torch
import numpy as np
from PIL import Image
import sys
import os
import json
import asyncio
from server import PromptServer
from aiohttp import web
import folder_paths

# Intentamos importar el NUEVO SDK de Google
try:
    from google import genai
    HAS_GENAI = True
except ImportError:
    HAS_GENAI = False

TOKENS_FILE = os.path.join(folder_paths.base_path, "models", "academia_tokens.json")

# --- RUTAS API PARA GUARDAR Y LEER EL TOKEN DE FORMA SEGURA ---
@PromptServer.instance.routes.get("/academia/gemini_token")
async def get_gemini_token(request):
    try:
        if os.path.exists(TOKENS_FILE):
            with open(TOKENS_FILE, "r") as f:
                data = json.load(f)
                return web.json_response({"token": data.get("gemini", "")})
    except: pass
    return web.json_response({"token": ""})

@PromptServer.instance.routes.post("/academia/gemini_token")
async def save_gemini_token(request):
    data = await request.json()
    token = data.get("token", "")
    try:
        tokens = {}
        if os.path.exists(TOKENS_FILE):
            with open(TOKENS_FILE, "r") as f:
                tokens = json.load(f)
        tokens["gemini"] = token
        with open(TOKENS_FILE, "w") as f:
            json.dump(tokens, f)
        return web.json_response({"status": "success"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})

# --- RUTA API: Para buscar modelos dinámicamente ---
@PromptServer.instance.routes.post("/academia/gemini_models")
async def fetch_gemini_models(request):
    data = await request.json()
    api_key = data.get("api_key", "").strip()
    
    # Si la clave está oculta (****) o vacía, la intentamos leer del disco duro
    if not api_key or api_key == "****":
        try:
            if os.path.exists(TOKENS_FILE):
                with open(TOKENS_FILE, "r") as f:
                    tdata = json.load(f)
                    api_key = tdata.get("gemini", "")
        except: pass

    if not api_key or api_key == "****":
        return web.json_response({"error": "No API Key provided. Please paste your API Key or save it first."})
    if not HAS_GENAI:
        return web.json_response({"error": "The 'google-genai' library is not installed."})
        
    try:
        def get_models():
            client = genai.Client(api_key=api_key, http_options={'api_version': 'v1beta'})
            models_list = []
            for m in client.models.list():
                name = m.name
                if name.startswith("models/"):
                    name = name.replace("models/", "")
                models_list.append(name)
            return models_list
            
        models = await asyncio.to_thread(get_models)
        return web.json_response({"models": models})
    except Exception as e:
        return web.json_response({"error": str(e)})


class AcademiaGeminiVision:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        # AQUI SE AGREGO EL NOMBRE EXACTO A LA LISTA PERMITIDA
        default_models = [
            "gemma-4-26b-a4b-it",
            "gemini-3.5-flash",
            "gemini-3.1-pro-preview",
            "gemini-3.1-flash-lite",
            "gemini-3-flash-preview",
            "gemma-4",
            "gemini-2.5-pro",
            "gemini-2.5-flash"
        ]
        return {
            "required": {
                "instruction": ("STRING", {"multiline": True, "default": "Analyze the provided input and format the output as a detailed JSON. If generating bounding boxes, ensure they match the provided resolution."}),
                "api_key": ("STRING", {"default": ""}),
                "model": (default_models, {"default": "gemma-4-26b-a4b-it"}), # Se actualizó el modelo por defecto
            },
            "optional": {
                "image": ("IMAGE", {"default": None}),
                "external_prompt": ("STRING", {"forceInput": True}),
                # --- NUEVOS CABLES OPCIONALES DE RESOLUCIÓN ---
                "width": ("INT", {"forceInput": True}),
                "height": ("INT", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "analyze"
    CATEGORY = "Academia SD"

    def analyze(self, instruction, api_key, model, image=None, external_prompt=None, width=None, height=None):
        if not HAS_GENAI:
            error_msg = "Error: 'google-genai' library is not installed. Please run: pip install google-genai"
            print(f"[AcademiaSD] ❌ {error_msg}")
            return (error_msg,)
        
        # --- LECTURA SEGURA DE LA API KEY ---
        if not api_key or api_key.strip() == "" or api_key.strip() == "****":
            try:
                if os.path.exists(TOKENS_FILE):
                    with open(TOKENS_FILE, "r") as f:
                        tdata = json.load(f)
                        api_key = tdata.get("gemini", "")
            except:
                pass

        if not api_key or api_key.strip() == "" or api_key.strip() == "****":
            error_msg = "Error: API Key is missing. Please provide a valid Google Gemini API Key."
            print(f"[AcademiaSD] ❌ {error_msg}")
            return (error_msg,)

        try:
            print(f"[AcademiaSD] 👁️✨ Sending request to {model}...")
            client = genai.Client(api_key=api_key.strip(), http_options={'api_version': 'v1beta'})
            
            contents = []
            
            # 1. Procesar Imagen (Si se conectó)
            if image is not None:
                i = 255. * image.cpu().numpy()
                img = Image.fromarray(np.clip(i[0], 0, 255).astype(np.uint8))
                contents.append(img)
            
            # 2. Procesar Textos
            final_text = instruction
            
            # 3. INYECTAR LA RESOLUCIÓN AL PROMPT SI ESTÁN CONECTADAS
            if width is not None and height is not None:
                final_text += f"\n\n[RESOLUTION INFO]\nThe target image resolution is {width}px (Width) by {height}px (Height). If you generate bounding boxes (bbox), you MUST map the coordinates strictly to these dimensions."
            elif width is not None:
                final_text += f"\n\n[RESOLUTION INFO]\nThe target image width is {width}px. Please map your coordinates accordingly."
            elif height is not None:
                final_text += f"\n\n[RESOLUTION INFO]\nThe target image height is {height}px. Please map your coordinates accordingly."

            # 4. Inyectar Prompt Externo si existe
            if external_prompt and str(external_prompt).strip() != "":
                final_text += f"\n\n--- EXTERNAL PROMPT / DATA ---\n{external_prompt}"
            
            if final_text.strip():
                contents.append(final_text)

            if not contents:
                return ("Error: Provide at least an image or a text instruction.",)

            # Enviar a Gemini
            response = client.models.generate_content(
                model=model,
                contents=contents
            )
            
            print(f"[AcademiaSD] ✅ {model} successfully generated the content!")
            return (response.text,)

        except Exception as e:
            print(f"[AcademiaSD] ❌ Gemini API Error: {e}")
            return (f"Error: {str(e)}",)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_GeminiVision": AcademiaGeminiVision
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_GeminiVision": "Academia SD Gemini Vision 👁️✨"
}

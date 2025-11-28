import torch
import numpy as np
from PIL import Image
import sys
import os

# Importación segura de la librería
try:
    import google.generativeai as genai
    GENAI_AVAILABLE = True
except ImportError:
    GENAI_AVAILABLE = False

class AcademiaSD_Gemini_Node:
    def __init__(self):
        pass
    
    @classmethod
    def INPUT_TYPES(s):
        # LISTA MAESTRA DE MODELOS
        ALL_MODELS = [
            # --- RECOMENDADOS ---
            "models/gemini-2.0-flash",
            "models/gemini-2.0-pro-exp",
            
            # --- GEMINI 3 & 2.5 ---
            "models/gemini-3-pro-preview",
            "models/gemini-3-pro-image-preview",
            "models/gemini-2.5-flash",
            "models/gemini-2.5-pro",
            "models/gemini-2.5-pro-preview-06-05",
            "models/gemini-2.5-pro-preview-05-06",
            "models/gemini-2.5-pro-preview-03-25",
            "models/gemini-2.5-flash-image",
            "models/gemini-2.5-flash-image-preview",
            "models/gemini-2.5-flash-preview-09-2025",
            "models/gemini-2.5-flash-lite",
            "models/gemini-2.5-flash-lite-preview-09-2025",
            "models/gemini-2.5-computer-use-preview-10-2025",
            "models/gemini-2.5-flash-preview-tts",
            "models/gemini-2.5-pro-preview-tts",

            # --- GEMINI 2.0 VARIANTS ---
            "models/gemini-2.0-flash-exp",
            "models/gemini-2.0-pro-exp-02-05",
            "models/gemini-2.0-flash-001",
            "models/gemini-2.0-flash-lite",
            "models/gemini-2.0-flash-lite-001",
            "models/gemini-2.0-flash-lite-preview",
            "models/gemini-2.0-flash-lite-preview-02-05",
            "models/gemini-2.0-flash-thinking-exp",
            "models/gemini-2.0-flash-thinking-exp-01-21",
            "models/gemini-2.0-flash-thinking-exp-1219",
            
            # --- SPECIALS ---
            "models/nano-banana-pro-preview",
            "models/gemini-exp-1206",
            "models/learnlm-2.0-flash-experimental",
            "models/gemini-robotics-er-1.5-preview",
            
            # --- GEMMA ---
            "models/gemma-3-27b-it",
            "models/gemma-3-12b-it",
            "models/gemma-3-4b-it",
            "models/gemma-3-1b-it",
            "models/gemma-3n-e4b-it",
            "models/gemma-3n-e2b-it",
            
            # --- LEGACY ---
            "models/gemini-1.5-pro",
            "models/gemini-1.5-flash",
            "models/gemini-flash-latest",
            "models/gemini-pro-latest",
        ]

        return {
            "required": {
                # AHORA ES OPCIONAL. Si se deja vacío, busca el archivo txt.
                "api_key": ("STRING", {"multiline": False, "default": "", "placeholder": "Déjalo vacío para usar gemini_api_key.txt"}),
                "model_selector": (ALL_MODELS, {"default": "models/gemini-2.0-flash"}),
                "prompt": ("STRING", {"multiline": True, "default": "Describe this image in extreme detail...", "dynamicPrompts": False}),
            },
            "optional": {
                "image": ("IMAGE",),
                "manual_model_v2": ("STRING", {"multiline": False, "default": "", "placeholder": "Opcional: Si sale un modelo nuevo, escríbelo aquí"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("detailed_prompt",)
    FUNCTION = "generate_content"
    CATEGORY = "AcademiaSD/GoogleAI"

    def tensor_to_pil(self, image_tensor):
        pil_images = []
        for img in image_tensor:
            i = 255. * img.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))
            pil_images.append(img)
        return pil_images

    def get_api_key(self, provided_key):
        """
        Lógica para obtener la API Key:
        1. Si el usuario escribió una en el nodo, usa esa.
        2. Si no, busca el archivo gemini_api_key.txt en la misma carpeta que este script.
        """
        key = provided_key.strip()
        if key and "AIza" in key:
            return key
        
        # Intentamos cargar desde archivo
        try:
            current_dir = os.path.dirname(os.path.realpath(__file__))
            key_file_path = os.path.join(current_dir, "gemini_api_key.txt")
            
            if os.path.exists(key_file_path):
                with open(key_file_path, 'r', encoding='utf-8') as f:
                    file_key = f.read().strip()
                    if "AIza" in file_key:
                        print(f"[AcademiaSD] API Key cargada desde: {key_file_path}")
                        return file_key
        except Exception as e:
            print(f"[AcademiaSD] Error leyendo archivo de clave: {e}")
            
        return None

    def generate_content(self, api_key, model_selector, prompt, image=None, manual_model_v2=""):
        # 1. Validar Librería
        if not GENAI_AVAILABLE:
            msg = "Error: Librería google-generativeai no instalada."
            return {"ui": {"text": [msg]}, "result": (msg,)}
        
        # 2. Obtener API Key (Manual o Archivo)
        valid_api_key = self.get_api_key(api_key)
        
        if not valid_api_key:
            msg = "Error: No se encontró API Key. Escríbela en el nodo O crea el archivo 'gemini_api_key.txt' en la carpeta nodes."
            return {"ui": {"text": [msg]}, "result": (msg,)}

        # 3. Selección de modelo
        manual_val = manual_model_v2.strip()
        if len(manual_val) > 100 or "ERROR" in manual_val:
             model_to_use = model_selector
        elif manual_val:
            model_to_use = manual_val
        else:
            model_to_use = model_selector

        # 4. Configurar
        genai.configure(api_key=valid_api_key)
        generation_config = {"temperature": 1.0, "max_output_tokens": 8192}
        
        safety_settings = [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
        ]

        try:
            # 5. Generar
            model = genai.GenerativeModel(
                model_name=model_to_use,
                generation_config=generation_config,
                safety_settings=safety_settings
            )
            
            inputs = [prompt]
            if image is not None:
                pil_images = self.tensor_to_pil(image)
                inputs.extend(pil_images)

            response = model.generate_content(inputs)
            
            return {"ui": {"text": [response.text]}, "result": (response.text,)}

        except Exception as e:
            error_msg = str(e)
            diagnosis = f"❌ ERROR CON EL MODELO '{model_to_use}':\n{error_msg}"
            return {"ui": {"text": [diagnosis]}, "result": (diagnosis,)}

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_Gemini_Node": AcademiaSD_Gemini_Node
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_Gemini_Node": "🤖 Gemini Vision (AcademiaSD)"
}
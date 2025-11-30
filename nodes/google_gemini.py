import torch
import numpy as np
from PIL import Image
import sys
import os

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
        ALL_MODELS = [
            "models/gemini-2.0-flash",
            "models/gemini-2.0-pro-exp",
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
            "models/nano-banana-pro-preview",
            "models/gemini-exp-1206",
            "models/learnlm-2.0-flash-experimental",
            "models/gemini-robotics-er-1.5-preview",
            "models/gemma-3-27b-it",
            "models/gemma-3-12b-it",
            "models/gemma-3-4b-it",
            "models/gemma-3-1b-it",
            "models/gemma-3n-e4b-it",
            "models/gemma-3n-e2b-it",
            "models/gemini-1.5-pro",
            "models/gemini-1.5-flash",
            "models/gemini-flash-latest",
            "models/gemini-pro-latest",
        ]

        return {
            "required": {
                "api_key": ("STRING", {"multiline": False, "default": "", "placeholder": "Leave empty to use gemini_api_key.txt"}),
                "model_selector": (ALL_MODELS, {"default": "models/gemini-2.0-flash"}),
                
                "prefix_prompt": ("STRING", {
                    "multiline": True, 
                    "default": "Create an extremely detailed prompt for an image generative AI based on this input:",
                }),

                "main_prompt": ("STRING", {
                    "multiline": True, 
                    "default": "Describe this image...", 
                }),

                # HE ACTUALIZADO EL SUFIJO POR DEFECTO PARA PEDIR EL NEGATIVO
                "suffix_prompt": ("STRING", {
                    "multiline": True, 
                    "default": ". Write the positive prompt first. Then, add the separator '---NEGATIVE---' followed by a detailed negative prompt (things to avoid). Do not output reasoning.",
                }),
            },
            "optional": {
                "image": ("IMAGE",),
            }
        }

    # AHORA TENEMOS 2 SALIDAS DE TEXTO
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive_prompt", "negative_prompt")
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
        key = provided_key.strip()
        if key and "AIza" in key:
            return key
        try:
            current_dir = os.path.dirname(os.path.realpath(__file__))
            key_file_path = os.path.join(current_dir, "gemini_api_key.txt")
            if os.path.exists(key_file_path):
                with open(key_file_path, 'r', encoding='utf-8') as f:
                    file_key = f.read().strip()
                    if "AIza" in file_key:
                        print(f"[AcademiaSD] API Key loaded from: {key_file_path}")
                        return file_key
        except Exception as e:
            print(f"[AcademiaSD] Error reading key file: {e}")
            pass
        return None

    def generate_content(self, api_key, model_selector, prefix_prompt, main_prompt, suffix_prompt, image=None):
        if not GENAI_AVAILABLE:
            msg = "Error: 'google-generativeai' library not installed."
            return {"ui": {"text": [msg]}, "result": (msg, "")} # Devuelve 2 valores
        
        valid_api_key = self.get_api_key(api_key)
        if not valid_api_key:
            msg = "Error: No valid API Key found."
            return {"ui": {"text": [msg]}, "result": (msg, "")}

        model_to_use = model_selector
        final_user_message = f"{prefix_prompt}\n\n{main_prompt}\n\n{suffix_prompt}"

        genai.configure(api_key=valid_api_key)
        generation_config = {"temperature": 1.0, "max_output_tokens": 8192}
        
        safety_settings = [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
        ]

        try:
            model = genai.GenerativeModel(
                model_name=model_to_use,
                generation_config=generation_config,
                safety_settings=safety_settings
            )
            
            inputs = [final_user_message]
            if image is not None:
                pil_images = self.tensor_to_pil(image)
                inputs.extend(pil_images)

            response = model.generate_content(inputs)
            full_text = response.text
            
            # --- LÓGICA DE SEPARACIÓN (SPLIT) ---
            separator = "---NEGATIVE---"
            
            if separator in full_text:
                parts = full_text.split(separator)
                pos_prompt = parts[0].strip()
                neg_prompt = parts[1].strip()
            else:
                # Si la IA olvida el separador, todo va al positivo y el negativo se queda vacío
                pos_prompt = full_text.strip()
                neg_prompt = ""

            # En la UI mostramos el texto completo para ver qué ha hecho la IA
            # Pero devolvemos los textos separados a los nodos siguientes
            return {"ui": {"text": [full_text]}, "result": (pos_prompt, neg_prompt)}

        except Exception as e:
            error_msg = str(e)
            diagnosis = f"❌ ERROR WITH MODEL '{model_to_use}':\n{error_msg}"
            if "404" in error_msg:
                diagnosis += "\n\n(Tip: Model not found or access denied)"
            
            return {"ui": {"text": [diagnosis]}, "result": (diagnosis, "")}

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_Gemini_Node": AcademiaSD_Gemini_Node
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_Gemini_Node": "🤖 Gemini Vision (AcademiaSD)"
}
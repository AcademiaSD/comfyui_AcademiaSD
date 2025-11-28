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
            "models/gemini-2.5-flash",
            "models/gemini-2.5-pro",
            "models/gemini-2.5-pro-preview-05-06",
            "models/gemini-2.5-flash-image",
            "models/gemini-2.0-flash-exp",
            "models/gemini-2.0-pro-exp-02-05",
            "models/gemini-2.0-flash-thinking-exp",
            "models/gemini-exp-1206",
            "models/gemini-1.5-pro",
            "models/gemini-1.5-flash",
            "models/gemma-3-27b-it",
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

                "suffix_prompt": ("STRING", {
                    "multiline": True, 
                    "default": ". Do not make comments or show the reasoning chain, write exclusively the prompt.",
                }),
            },
            "optional": {
                "image": ("IMAGE",),
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
        # 1. Check Library
        if not GENAI_AVAILABLE:
            msg = "Error: 'google-generativeai' library not installed. Please install it via pip."
            return {"ui": {"text": [msg]}, "result": (msg,)}
        
        # 2. Check API Key
        valid_api_key = self.get_api_key(api_key)
        if not valid_api_key:
            msg = "Error: No valid API Key found. Please enter it in the node or create 'gemini_api_key.txt'."
            return {"ui": {"text": [msg]}, "result": (msg,)}

        model_to_use = model_selector

        # 3. Build Prompt
        final_user_message = f"{prefix_prompt}\n\n{main_prompt}\n\n{suffix_prompt}"

        # 4. Configure Google AI
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
            
            return {"ui": {"text": [response.text]}, "result": (response.text,)}

        except Exception as e:
            error_msg = str(e)
            diagnosis = f"❌ ERROR WITH MODEL '{model_to_use}':\n{error_msg}"
            
            # Helper for common errors
            if "404" in error_msg:
                diagnosis += "\n\n(Tip: This model might not be available in your account yet, try a standard model like gemini-1.5-flash)"
            
            return {"ui": {"text": [diagnosis]}, "result": (diagnosis,)}

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_Gemini_Node": AcademiaSD_Gemini_Node
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_Gemini_Node": "🤖 Gemini Vision (AcademiaSD)"
}
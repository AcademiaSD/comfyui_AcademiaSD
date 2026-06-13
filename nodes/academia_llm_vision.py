import torch
from PIL import Image
import numpy as np

class AcademiaSD_LLM_Vision:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("ACADEMIA_MODEL",),
                "instruction": ("STRING", {"multiline": True, "default": "Describe this image in detail. Focus on lighting, composition, and subjects."}),
                "max_tokens": ("INT", {"default": 512, "min": 64, "max": 2048}),
            },
            "optional": {
                "image": ("IMAGE",),
                "external_prompt": ("STRING", {"forceInput": True}),
                "width": ("INT", {"forceInput": True}),
                "height": ("INT", {"forceInput": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("caption",)
    FUNCTION = "generate_caption"
    CATEGORY = "Academia SD"

    def generate_caption(self, model, instruction, max_tokens, image=None, external_prompt=None, width=None, height=None):
        loaded_model = model["model"]
        processor = model["processor"]

        # 1. Construcción del Prompt
        final_text = instruction
        if width is not None: final_text += f"\n[Width]: {width}px"
        if height is not None: final_text += f"\n[Height]: {height}px"
        if external_prompt and external_prompt.strip(): 
            final_text += f"\n\nAdditional Context: {external_prompt}"

        # 2. Preparación de Imagen
        img = None
        if image is not None:
            # Convertir tensor a PIL
            i = 255. * image[0].cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

        # 3. CONSTRUCCIÓN DE CONVERSACIÓN
        # Si hay imagen, usamos el formato de visión, si no, texto puro
        try:
            if img:
                conversation = [
                    {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": final_text}]}
                ]
            else:
                conversation = [
                    {"role": "user", "content": [{"type": "text", "text": final_text}]}
                ]
            
            text_prompt = processor.apply_chat_template(conversation, add_generation_prompt=True, tokenize=False)
        except Exception:
            text_prompt = f"<image>\n{final_text}" if img else final_text

        # 4. PROCESADO
        inputs = {}
        if img:
            inputs = processor(text=text_prompt, images=[img], return_tensors="pt").to(loaded_model.device)
        else:
            inputs = processor(text=text_prompt, return_tensors="pt").to(loaded_model.device)

        # 5. GENERACIÓN
        with torch.no_grad():
            gen_kwargs = {
                "max_new_tokens": max_tokens,
                "do_sample": True,
                "temperature": 0.6,
                "pad_token_id": processor.tokenizer.pad_token_id if hasattr(processor, "tokenizer") else None
            }
            
            generated_ids = loaded_model.generate(**inputs, **gen_kwargs)
            
            input_length = inputs["input_ids"].shape[1]
            generated_ids = generated_ids[:, input_length:]
            
            caption = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        
        return (caption,)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_LLM_Vision": AcademiaSD_LLM_Vision
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_LLM_Vision": "AcademiaSD LLM Vision 👁️"
}
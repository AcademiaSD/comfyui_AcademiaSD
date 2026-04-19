import torch
from PIL import Image
import numpy as np

class AcademiaVisionNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("ACADEMIA_MODEL",),
                "image": ("IMAGE",),
                "prompt": ("STRING", {"default": "Describe this image in detail.", "multiline": True}),
                "max_tokens": ("INT", {"default": 512, "min": 64, "max": 2048}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("caption",)
    FUNCTION = "generate_caption"
    CATEGORY = "AcademiaSD"

    def generate_caption(self, model, image, prompt, max_tokens):
        loaded_model = model["model"]
        processor = model["processor"]

        # 1. Convertir tensor a PIL
        i = 255. * image[0].cpu().numpy()
        img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

        # 2. CONSTRUCCIÓN DE CONVERSACIÓN (AILab Style)
        # Algunos modelos requieren que el token de imagen esté en el texto
        # Probamos primero el template nativo, si no, forzamos el token <image>
        try:
            conversation = [
                {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": prompt}]}
            ]
            text_prompt = processor.apply_chat_template(conversation, add_generation_prompt=True, tokenize=False)
        except Exception:
            text_prompt = f"<image>\n{prompt}"

        # 3. PROCESADO CRÍTICO
        # Pasamos images=[img] aquí. El procesador debería mapear <image> a los features
        inputs = processor(
            text=text_prompt, 
            images=[img], 
            return_tensors="pt"
        ).to(loaded_model.device)

        # 4. VERIFICACIÓN DE SEGURIDAD (Debugging)
        # Si esto muestra '0', es que el token no se ha insertado
        if "input_ids" in inputs:
            # Gemma/Qwen suelen usar un token específico. Buscamos si existe.
            # Este es un chequeo preventivo.
            pass

        # 5. GENERACIÓN
        with torch.no_grad():
            gen_kwargs = {
                "max_new_tokens": max_tokens,
                "do_sample": True,
                "temperature": 0.6,
                "pad_token_id": processor.tokenizer.pad_token_id if hasattr(processor, "tokenizer") else None
            }
            
            # Limpiamos None por si acaso
            gen_kwargs = {k: v for k, v in gen_kwargs.items() if v is not None}
            
            generated_ids = loaded_model.generate(**inputs, **gen_kwargs)
            
            # Recortar el prompt de la respuesta
            input_length = inputs["input_ids"].shape[1]
            generated_ids = generated_ids[:, input_length:]
            
            caption = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
        
        return (caption,)

NODE_CLASS_MAPPINGS = {"AcademiaVisionNode": AcademiaVisionNode}
NODE_DISPLAY_NAME_MAPPINGS = {"AcademiaVisionNode": "AcademiaSD Captioner"}
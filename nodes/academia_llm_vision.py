import torch
from PIL import Image
import numpy as np
import json
import re


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
        import json
        import re
        import torch
        import numpy as np
        from PIL import Image

        loaded_model = model["model"]
        processor = model["processor"]

        # 1. Preparación del Prompt
        final_text = f"{instruction}\n\nContext: {external_prompt}" if external_prompt else instruction
        
        # 2. Procesamiento de imagen
        img = None
        if image is not None:
            i = 255. * image[0].cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

        conversation = [
            {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": final_text}]} if img 
            else {"role": "user", "content": [{"type": "text", "text": final_text}]}
        ]
        text_prompt = processor.apply_chat_template(conversation, add_generation_prompt=True, tokenize=False)
        inputs = processor(text=text_prompt, images=[img] if img else None, return_tensors="pt").to(loaded_model.device)

        # 3. Generación
        with torch.no_grad():
            gen_kwargs = {
                "max_new_tokens": max_tokens, 
                "do_sample": True, 
                "temperature": 0.2, 
                "pad_token_id": processor.tokenizer.pad_token_id if hasattr(processor, "tokenizer") else None
            }
            generated_ids = loaded_model.generate(**inputs, **gen_kwargs)
            input_length = inputs["input_ids"].shape[1]
            generated_ids = generated_ids[:, input_length:]
            raw_output = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]

        # 4. Post-procesamiento (Escalado y Conversión a XYXY)
        return_value = raw_output 
        
        try:
            # Limpieza para extraer solo el JSON
            cleaned_json = re.sub(r"```json|```", "", raw_output).strip()
            start = cleaned_json.find('{')
            end = cleaned_json.rfind('}') + 1
            
            if start != -1 and end != -1:
                data = json.loads(cleaned_json[start:end])
                
                # Definir dimensiones de destino (usar 1000 si no hay info)
                w = width if width is not None and width > 0 else 1000
                h = height if height is not None and height > 0 else 1000
                
                # Buscamos la clave específica
                if "compositional_deconstruction" in data and "elements" in data["compositional_deconstruction"]:
                    elements = data["compositional_deconstruction"]["elements"]
                    
                    # Iteramos sobre los elementos para modificar el JSON original
                    for el in elements:
                        if "bbox" in el and len(el["bbox"]) == 4:
                            ymin, xmin, ymax, xmax = el["bbox"]
                            
                            # Escalado matemático a píxeles
                            # El modelo da [ymin, xmin, ymax, xmax]
                            # Convertimos a [x1, y1, x2, y2] que es el estándar universal
                            x1 = int((xmin / 1000) * w)
                            y1 = int((ymin / 1000) * h)
                            x2 = int((xmax / 1000) * w)
                            y2 = int((ymax / 1000) * h)
                            
                            # Actualizamos el elemento
                            el["bbox"] = [x1, y1, x2, y2]
                
                # Re-serializamos el objeto modificado
                return_value = json.dumps(data)
                print(f"[AcademiaSD] ✅ JSON procesado correctamente a {w}x{h}")
                
        except Exception as e:
            print(f"[AcademiaSD] ❌ Error durante el escalado: {e}")
            # Devolvemos el original en caso de error para no romper nada
        
        return (str(return_value),)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_LLM_Vision": AcademiaSD_LLM_Vision
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_LLM_Vision": "AcademiaSD LLM Vision 👁️"
}
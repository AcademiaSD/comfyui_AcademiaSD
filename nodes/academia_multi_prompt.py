import json

class AcademiaMultiPrompt:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "index": ("INT", {"default": 1, "min": 1, "max": 1000, "step": 1}),
                "prompt_data": ("STRING", {"default": "[]"}), # JSON Oculto
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "get_prompt"
    CATEGORY = "Academia SD"

    def get_prompt(self, index, prompt_data="[]"):
        try:
            prompts = json.loads(prompt_data)
        except:
            prompts =[]

        if not prompts:
            return ("",)

        # El index viene de base 1 (Loop 1, Loop 2...). En programación es base 0.
        target_idx = index - 1
        
        # Si el índice es menor a 1, forzamos al primer prompt
        if target_idx < 0:
            target_idx = 0
            
        # Si el índice supera la cantidad de prompts que el usuario ha escrito, 
        # mantenemos el último prompt disponible para que el vídeo no se rompa o se vuelva negro.
        if target_idx >= len(prompts):
            target_idx = len(prompts) - 1

        selected_prompt = prompts[target_idx].get("text", "")
        print(f"[AcademiaSD] 📝 Loop {index} -> Injecting Prompt {target_idx + 1}")

        return (selected_prompt,)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MultiPrompt": AcademiaMultiPrompt
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MultiPrompt": "Academia SD Multi-Prompt 📝"
}
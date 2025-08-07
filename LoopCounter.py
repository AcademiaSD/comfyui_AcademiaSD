import os
import json
import folder_paths

# --- Constante compartida por los nodos de contador y reseteo ---
FILENAME = "loops.json"
FILE_PATH = os.path.join(folder_paths.get_output_directory(), FILENAME)

# =================================================================================
# NODO 1: El Contador principal (Inicia en 0)
# =================================================================================
class LoopCounter:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {}}

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("loop_count",)
    FUNCTION = "execute"
    CATEGORY = "Utilities/Counters"

    @classmethod
    def IS_CHANGED(s, *args, **kwargs):
        import random
        return random.random()

    def execute(self):
        try:
            with open(FILE_PATH, 'r') as f:
                data = json.load(f)
                current_value_to_output = data.get('loop_count', 0)
        except (FileNotFoundError, json.JSONDecodeError):
            print(f"[LoopCounter] File '{FILENAME}' not found. Starting in 0.")
            current_value_to_output = 0

        next_value_to_save = current_value_to_output + 1

        print(f"[LoopCounter] -> Current: {current_value_to_output}. Saving for next time: {next_value_to_save}")

        try:
            with open(FILE_PATH, 'w') as f:
                json.dump({'loop_count': next_value_to_save}, f, indent=4)
        except Exception as e:
            print(f"[LoopCounter] ERROR: The file could not be saved. {e}")

        return (current_value_to_output,)

# =================================================================================
# NODO 2: El Reseteador dedicado (Resetea a 0)
# =================================================================================
class ResetCounter:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"trigger_reset": ("BOOLEAN", {"default": True, "label_on": "RESET", "label_off": "RESET"})}}

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "execute"
    CATEGORY = "Utilities/Counters"

    def execute(self, trigger_reset):
        print(f"[ResetCounter] Acción de reseteo ejecutada.")
        reset_value = 0

        try:
            with open(FILE_PATH, 'w') as f:
                json.dump({'loop_count': reset_value}, f, indent=4)
            print(f"[ResetCounter] Contador reseteado a {reset_value} en '{FILE_PATH}'")
        except Exception as e:
            print(f"[ResetCounter] ERROR: No se pudo crear el fichero de reseteo. {e}")

        return {}

# =================================================================================
# NODO 3: El Formateador de Nombres de Fichero (Padding)
# =================================================================================
class File_name:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "loop_count": ("INT", {"default": 0, "min": 0, "step": 1, "display": "number"}),
                "length": ("INT", {"default": 1, "min": 1, "step": 1, "display": "number"}),
                "filename_prefix": ("STRING", {"multiline": False, "default": "fotograma"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("formatted_filename",)
    FUNCTION = "format_filename"
    CATEGORY = "Utilities/Text"

    def format_filename(self, loop_count, length, filename_prefix):
        calculated_number = loop_count * length
        padded_number = f"{calculated_number:05d}"
        final_filename = f"{filename_prefix}_{padded_number}_.png"
        print(f"[File_name] -> target: {final_filename}")
        return (final_filename,)

# =================================================================================
# NODO 4: PromptBatchSelector – Prompt variable con batch index
# =================================================================================
class PromptBatchSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "batch_index": ("INT", {"default": 1, "min": 1, "max": 10, "step": 1}),
                "prompt_comun": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "lines": 7,
                    "placeholder": "Texto común que se aplicará a todos los prompts"
                }),
                "prompt_1": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
                "prompt_2": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
                "prompt_3": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
                "prompt_4": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
                "prompt_5": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
                "prompt_6": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
                "prompt_7": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
                "prompt_8": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
                "prompt_9": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
                "prompt_10": ("STRING", {"multiline": True, "default": "", "group": "Variantes de prompt"}),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "combine_prompt"
    CATEGORY = "AcademiaSD/Prompt"

    def combine_prompt(
        self,
        clip,
        batch_index,
        prompt_comun,
        prompt_1, prompt_2, prompt_3, prompt_4, prompt_5,
        prompt_6, prompt_7, prompt_8, prompt_9, prompt_10
    ):
        prompts = [
            prompt_1, prompt_2, prompt_3, prompt_4, prompt_5,
            prompt_6, prompt_7, prompt_8, prompt_9, prompt_10
        ]

        idx = max(1, min(batch_index, 10)) - 1
        extra_prompt = prompts[idx]
        final_prompt = f"{prompt_comun} {extra_prompt}".strip()

        print(f"[PromptBatchSelector] Prompt generado: '{final_prompt}'")

        from nodes import CLIPTextEncode
        encoder = CLIPTextEncode()
        return encoder.encode(clip=clip, text=final_prompt)


# =================================================================================
# Mapeo de Nodos para ComfyUI
# =================================================================================

NODE_CLASS_MAPPINGS = {
    "LoopCounterToFile": LoopCounter,
    "ResetCounterFile": ResetCounter,
    "File_namePadded": File_name,
    "PromptBatchSelector": PromptBatchSelector
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoopCounterToFile": "Counter (Start at 0)",
    "ResetCounterFile": "Reset Counter (Action)",
    "File_namePadded": "Filename (Padding)",
    "PromptBatchSelector": "Prompt Batch Selector"
}

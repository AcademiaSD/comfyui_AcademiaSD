import os
import json
import folder_paths

# --- Shared constant for the counter and reset nodes ---
FILENAME = "loops.json"
FILE_PATH = os.path.join(folder_paths.get_output_directory(), FILENAME)

# =================================================================================
# NODE 1: The main Counter (Starts at 0)
# =================================================================================
class LoopCounter:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {}}

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("loop_count",)
    FUNCTION = "execute"
    CATEGORY = "ComfyUI_AcademiaSD/Utilities/Counters"

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
            print(f"[LoopCounter] File '{FILENAME}' not found. Starting at 0.")
            current_value_to_output = 0

        next_value_to_save = current_value_to_output + 1
        print(f"[LoopCounter] -> Current: {current_value_to_output}. Saving for next time: {next_value_to_save}")
        try:
            with open(FILE_PATH, 'w') as f:
                json.dump({'loop_count': next_value_to_save}, f, indent=4)
        except Exception as e:
            print(f"[LoopCounter] ERROR: Could not save the file. {e}")
        return (current_value_to_output,)

# =================================================================================
# NODE 2: The dedicated Resetter (Resets to 0)
# =================================================================================
class ResetCounter:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"trigger_reset": ("BOOLEAN", {"default": True, "label_on": "RESET", "label_off": "RESET"})}}

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "execute"
    CATEGORY = "ComfyUI_AcademiaSD/Utilities/Counters"

    def execute(self, trigger_reset):
        print(f"[ResetCounter] Reset action executed.")
        reset_value = 0
        try:
            with open(FILE_PATH, 'w') as f:
                json.dump({'loop_count': reset_value}, f, indent=4)
            print(f"[ResetCounter] Counter reset to {reset_value} in '{FILE_PATH}'")
        except Exception as e:
            print(f"[ResetCounter] ERROR: Could not write the reset file. {e}")
        return {}

# =================================================================================
# NODE 3: The File Name Formatter (Padding)
# =================================================================================
class PaddedFileName:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "loop_count": ("INT", {"default": 0, "min": 0, "step": 1, "display": "number"}),
                "multiplier": ("INT", {"default": 1, "min": 1, "step": 1, "display": "number"}),
                "filename_prefix": ("STRING", {"multiline": False, "default": "frame"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("formatted_filename",)
    FUNCTION = "format_filename"
    CATEGORY = "ComfyUI_AcademiaSD/Utilities/Counters"

    def format_filename(self, loop_count, multiplier, filename_prefix):
        calculated_number = loop_count * multiplier
        padded_number = f"{calculated_number:05d}"
        final_filename = f"{filename_prefix}_{padded_number}_.png"
        print(f"[PaddedFileName] -> Output: {final_filename}")
        return (final_filename,)

# =================================================================================
# NODE 4: PromptBatchSelector – Alternative "by line" version
# =================================================================================
class PromptBatchSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "batch_index": ("INT", {"default": 1, "min": 1, "step": 1}),
                "common_prompt": ("STRING", {
                    "multiline": True,
                    "default": "beautiful scenery, masterpiece, best quality",
                    "placeholder": "Common styles and keywords for all prompts..."
                }),
                "prompts_by_line": ("STRING", {
                    "multiline": True,
                    "default": "a happy person smiling\na sad person crying\nan angry person shouting",
                    "placeholder": "Enter one prompt per line. Line 1 corresponds to batch_index 1, etc."
                }),
            }
        }

    RETURN_TYPES = ("CONDITIONING",)
    FUNCTION = "combine_prompt"
    CATEGORY = "ComfyUI_AcademiaSD/Conditioning"

    def combine_prompt(self, clip, batch_index, common_prompt, prompts_by_line):
        prompts = prompts_by_line.strip().split('\n')
        idx = batch_index - 1
        extra_prompt = ""
        if 0 <= idx < len(prompts):
            extra_prompt = prompts[idx].strip()
            print(f"[PromptBatchSelector] Batch Index: {batch_index} -> Using line {idx + 1}: '{extra_prompt}'")
        else:
            print(f"[PromptBatchSelector] WARNING: batch_index ({batch_index}) is out of range for available prompts ({len(prompts)}). Using only the common prompt.")
        final_prompt = f"{common_prompt.strip()} {extra_prompt.strip()}".strip()
        print(f"[PromptBatchSelector] Final prompt: '{final_prompt}'")
        from nodes import CLIPTextEncode
        encoder = CLIPTextEncode()
        return encoder.encode(clip=clip, text=final_prompt)

# =================================================================================
# Node Mappings for ComfyUI
# =================================================================================

NODE_CLASS_MAPPINGS = {
    "LoopCounterToFile": LoopCounter,
    "ResetCounterFile": ResetCounter,
    "PaddedFileName": PaddedFileName,
    "PromptBatchSelector": PromptBatchSelector
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoopCounterToFile": "Counter (from file)",
    "ResetCounterFile": "Reset Counter (to file)",
    "PaddedFileName": "Padded File Name",
    "PromptBatchSelector": "Prompt Batch Selector (by line)"
}
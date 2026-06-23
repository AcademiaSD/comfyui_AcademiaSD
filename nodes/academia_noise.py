class AcademiaNoiseNode:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "seed_val": ("INT", {"default": 0, "min": 0, "max": 9007199254740991}), 
                "mode": (["fixed", "randomize", "increment", "decrement"], {"default": "fixed"}),
            }
        }
    
    # Única salida oficial
    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("seed",)
    FUNCTION = "process"
    CATEGORY = "Academia SD/Noise"

    def process(self, seed_val, mode):
        return (seed_val,)

NODE_CLASS_MAPPINGS = {"AcademiaSD_Noise": AcademiaNoiseNode}
NODE_DISPLAY_NAME_MAPPINGS = {"AcademiaSD_Noise": "Academia SD Advanced Seed Generator 🎲"}
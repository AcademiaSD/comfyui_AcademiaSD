class AcademiaTimeCalculator:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "frames": ("INT", {"default": 33, "min": 1, "max": 99999, "step": 1, "display": "number"}),
                "fps": ("FLOAT", {"default": 24.0, "min": 0.1, "max": 240.0, "step": 0.1, "display": "number"}),
            }
        }

    # Hemos quitado el SECONDS, dejamos solo FRAMES y FPS
    RETURN_TYPES = ("INT", "FLOAT")
    RETURN_NAMES = ("FRAMES", "FPS")
    FUNCTION = "calculate_time"
    CATEGORY = "Academia SD"

    def calculate_time(self, frames, fps):
        # Expulsamos los dos valores básicos para alimentar otros nodos
        return (frames, fps)

# Registrar el nodo
NODE_CLASS_MAPPINGS = {
    "AcademiaSD_TimeCalculator": AcademiaTimeCalculator
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_TimeCalculator": "Academia SD Time Calculator ⏱️"
}
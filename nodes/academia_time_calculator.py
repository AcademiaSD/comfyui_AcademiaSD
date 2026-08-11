class AcademiaTimeCalculator:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "frames": (
                    "INT",
                    {
                        "default": 33,
                        "min": 1,
                        "max": 99999,
                        "step": 1,
                        "display": "number"
                    }
                ),
                "fps": (
                    "FLOAT",
                    {
                        "default": 24.0,
                        "min": 0.1,
                        "max": 240.0,
                        "step": 0.1,
                        "display": "number"
                    }
                )
            }
        }

    # FRAMES y FPS se mantienen.
    # Añadimos DURATION como FLOAT.
    RETURN_TYPES = ("INT", "FLOAT", "FLOAT")
    RETURN_NAMES = ("FRAMES", "FPS", "duration")

    FUNCTION = "calculate_time"
    CATEGORY = "Academia SD"

    def calculate_time(self, frames, fps):

        # Duración REAL en segundos:
        # número de frames / frames por segundo
        duration = float(frames) / float(fps)

        return (frames, fps, duration)


# Registrar el nodo
NODE_CLASS_MAPPINGS = {
    "AcademiaSD_TimeCalculator": AcademiaTimeCalculator
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_TimeCalculator": "Academia SD Time Calculator ⏱️"
}
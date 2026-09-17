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

        # Los valores van TAMBIEN a la interfaz, y no por gusto. El texto grande
        # lo pinta el navegador, que solo puede leer los widgets; cuando `frames`
        # llega por un cable el widget se queda en su valor por defecto y la
        # pantalla enseña para siempre la cuenta de ese defecto, mientras las
        # salidas llevan la buena. Mandarlos desde aquí es la única forma de que
        # lo que se lee y lo que sale del nodo sean lo mismo.
        #
        # The values go to the UI as well, and not for show. The big label is
        # drawn by the browser, which can only read the widgets; when `frames`
        # arrives through a link the widget keeps its default and the display
        # shows that default's result for ever, while the outputs carry the real
        # one. Sending them from here is the only way to make what is read and
        # what leaves the node the same thing.
        return {
            "ui": {"asd_tiempo": [{"frames": int(frames),
                                   "fps": float(fps),
                                   "duration": duration}]},
            "result": (frames, fps, duration),
        }


# Registrar el nodo
NODE_CLASS_MAPPINGS = {
    "AcademiaSD_TimeCalculator": AcademiaTimeCalculator
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_TimeCalculator": "Academia SD Time Calculator ⏱️"
}
class AcademiaResolutionDisplayNode:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                # Entradas iniciales (Cambiados los nombres a input_video_width/height)
                "input_video_width": ("INT", {"forceInput": True}),
                "input_video_height": ("INT", {"forceInput": True}),
                # Entradas finales (Cambiados los nombres a output_video_width/height)
                "output_video_width": ("INT", {"forceInput": True}),
                "output_video_height": ("INT", {"forceInput": True}),
            },
            # Campo oculto (necesario para nodos que envían datos a la UI)
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "display_resolution"
    OUTPUT_NODE = True
    CATEGORY = "Academia SD"

    # Los parámetros de la función deben coincidir exactamente con los nombres de INPUT_TYPES
    def display_resolution(self, input_video_width, input_video_height, output_video_width, output_video_height, prompt=None, extra_pnginfo=None):
        
        # 1. Preparamos el texto que queremos mostrar en el nodo (Cambiado a Input/Output)
        text_to_display = (
            f"Input Video: {input_video_width} x {input_video_height}\n"
            f"Output Video: {output_video_width} x {output_video_height}"
        )
        
        # 2. Enviamos el texto al Frontend (Javascript) para que lo dibuje en la pantalla
        return {"ui": {"text": [text_to_display]}}

# Registrar el nodo
NODE_CLASS_MAPPINGS = {
    "AcademiaSD_ResolutionDisplay": AcademiaResolutionDisplayNode
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_ResolutionDisplay": "Academia SD Resolution Display 📐"
}
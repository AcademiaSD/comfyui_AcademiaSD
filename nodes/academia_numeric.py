class AcademiaNumericNode:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                # Usamos el widget INT nativo. No permite escribir puntos ni comas.
                "value": ("INT", {
                    "default": 1, 
                    "min": -99999999, 
                    "max": 99999999, 
                    "step": 1,
                    "display": "number"
                }),
            }
        }

    # Declaramos las dos salidas
    RETURN_TYPES = ("INT", "FLOAT")
    RETURN_NAMES = ("INT", "FLOAT")
    FUNCTION = "process_value"
    CATEGORY = "Academia SD"

    def process_value(self, value):
        # 1. SALIDA INT: El valor original tal cual se escribió (Ej: 15)
        int_val = int(value)
        
        # 2. SALIDA FLOAT: El mismo valor pero con tipo Float (Ej: 15.0)
        float_val = float(value)
        
        return (int_val, float_val)

# Registrar el nodo en ComfyUI
NODE_CLASS_MAPPINGS = {
    "AcademiaSD_Numeric": AcademiaNumericNode
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_Numeric": "Academia SD Numeric Input 🔢"
}
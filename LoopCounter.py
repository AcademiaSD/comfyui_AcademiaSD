import os
import json
import folder_paths

# --- Constante compartida por los nodos de contador y reseteo ---
# Para asegurar que ambos operan sobre el mismo fichero.
FILENAME = "loops.json"
FILE_PATH = os.path.join(folder_paths.get_output_directory(), FILENAME)

# =================================================================================
# NODO 1: El Contador principal (Inicia en 0)
# =================================================================================
class LoopCounter:
    """
    Un nodo que lee un número de un fichero JSON, lo devuelve, y guarda el siguiente
    número incrementado para la próxima ejecución.
    - La secuencia es 0, 1, 2, 3, 4, ...
    """

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
            # Intentar leer el valor guardado para esta ejecución
            with open(FILE_PATH, 'r') as f:
                data = json.load(f)
                # Si la clave no existe, empezamos en 0 por defecto
                current_value_to_output = data.get('loop_count', 0)
        
        except (FileNotFoundError, json.JSONDecodeError):
            # Si el fichero no existe, este es el primer ciclo. Empezamos en 0.
            print(f"[LoopCounter] File '{FILENAME}' not found. Starting in 0.")
            current_value_to_output = 0
        
        # Preparamos el valor para la SIGUIENTE ejecución
        next_value_to_save = current_value_to_output + 1
        
        print(f"[LoopCounter] -> Current: {current_value_to_output}. Saving for next time: {next_value_to_save}")

        # Guardar el valor para la siguiente ejecución
        try:
            with open(FILE_PATH, 'w') as f:
                json.dump({'loop_count': next_value_to_save}, f, indent=4)
        except Exception as e:
            print(f"[LoopCounter] ERROR: The file could not be saved. {e}")

        # Devolver el valor de la ejecución ACTUAL
        return (current_value_to_output,)

# =================================================================================
# NODO 2: El Reseteador dedicado (Resetea a 0)
# =================================================================================
class ResetCounter:
    """
    Un nodo de acción cuya única función es resetear el fichero del contador a 0.
    Debe ser ejecutado para que tenga efecto.
    """
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"trigger_reset": ("BOOLEAN", {"default": True, "label_on": "RESET", "label_off": "RESET"})}}

    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "execute"
    CATEGORY = "Utilities/Counters"

    def execute(self, trigger_reset):
        print(f"[ResetCounter] Acción de reseteo ejecutada.")
        # El valor al que se resetea ahora es 0
        reset_value = 0

        try:
            with open(FILE_PATH, 'w') as f:
                json.dump({'loop_count': reset_value}, f, indent=4)
            print(f"[ResetCounter] Contador reseteado a {reset_value} en '{FILE_PATH}'")
        except Exception as e:
            print(f"[ResetCounter] ERROR: No se pudo crear el fichero de reseteo. {e}")
        
        return {}

# =================================================================================
# NODO 3: El Formateador de Nombres de Fichero (Sin cambios)
# =================================================================================
class File_name:
    """
    Un nodo que toma un número, un prefijo y un multiplicador para crear
    un nombre de fichero formateado con ceros a la izquierda (padding).
    """
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
# Mapeo de Nodos para ComfyUI
# =================================================================================

NODE_CLASS_MAPPINGS = {
    "LoopCounterToFile": LoopCounter,
    "ResetCounterFile": ResetCounter,
    "File_namePadded": File_name
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoopCounterToFile": "Counter (Start at 0)",
    "ResetCounterFile": "Reset Counter (Action)",
    "File_namePadded": "Filename (Padding)"
}
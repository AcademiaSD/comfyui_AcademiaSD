import os
import folder_paths
from server import PromptServer

class AcademiaLoopCounter:
    
    # Variables de clase compartidas
    last_prompt_id = None
    last_returned_value = 1

    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "reset_counter": ("BOOLEAN", {"default": False, "label_on": "Yes", "label_off": "No"}),
                "start_value": ("INT", {"default": 1, "min": 0, "max": 9999}),
                "project_path": ("STRING", {"default": "test/rosaroja"}),
            }
        }

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("loop_index",)
    FUNCTION = "get_count"
    CATEGORY = "Academia SD"

    @classmethod
    def IS_CHANGED(s, **kwargs):
        # Obligamos siempre a ejecutar
        return float("NaN")

    def get_count(self, reset_counter, start_value, project_path):
        # 1. EL TRUCO DEFINITIVO: Leemos el DNI único de la ejecución actual de ComfyUI
        current_prompt_id = PromptServer.instance.last_prompt_id
        
        # Si el DNI es el mismo que el anterior, significa que estamos en la MISMA
        # vez que pulsaste el botón "Queue Prompt", por lo que devolvemos el valor cached
        # sin importar cuántos segundos u horas hayan pasado.
        if current_prompt_id == AcademiaLoopCounter.last_prompt_id and current_prompt_id is not None:
            print(f"[AcademiaSD] 🔄 Loop Counter Cached Output: {AcademiaLoopCounter.last_returned_value}")
            return (AcademiaLoopCounter.last_returned_value,)

        # Si el DNI es nuevo (porque has vuelto a darle a Queue), actualizamos nuestro registro
        AcademiaLoopCounter.last_prompt_id = current_prompt_id

        out_dir = folder_paths.get_output_directory()
        
        # 2. Rutas
        if project_path.strip() != "":
            safe_path = project_path.replace("\\", "/").strip("/")
            subfolder = os.path.dirname(safe_path)
            
            full_dir = os.path.join(out_dir, subfolder) if subfolder else out_dir
            os.makedirs(full_dir, exist_ok=True)
            
            file_path = os.path.join(out_dir, f"{safe_path}_loop_counter.txt")
        else:
            file_path = os.path.join(folder_paths.base_path, "academia_loop_counter.txt")

        # 3. Lógica del Contador
        if reset_counter:
            current_val = start_value
        else:
            current_val = start_value
            if os.path.exists(file_path):
                try:
                    with open(file_path, "r") as f:
                        content = f.read().strip()
                        if content:
                            current_val = int(content)
                except Exception as e:
                    print(f"[AcademiaSD] ⚠️ Error reading loop file: {e}")

        # 4. Guardar siguiente valor
        try:
            with open(file_path, "w") as f:
                f.write(str(current_val + 1))
        except Exception as e:
            print(f"[AcademiaSD] ❌ Error writing loop file: {e}")

        # 5. Guardar en memoria caché global
        AcademiaLoopCounter.last_returned_value = current_val

        print(f"[AcademiaSD] 🔄 Loop Counter Advanced: {current_val} (File: {os.path.basename(file_path)})")
        
        return (current_val,)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_LoopCounter": AcademiaLoopCounter
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_LoopCounter": "Academia SD Loop Counter 🔄"
}
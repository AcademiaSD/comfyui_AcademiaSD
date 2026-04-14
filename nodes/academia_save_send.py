import os
import json
import shutil
import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import folder_paths
from server import PromptServer
from aiohttp import web

# --- NUEVA API: Copiar de Output a Input cuando se pulsa el botón ---
@PromptServer.instance.routes.post("/academia/send_to_edit")
async def send_to_edit(request):
    data = await request.json()
    filename = data.get("filename")
    subfolder = data.get("subfolder", "")
    
    if not filename:
        return web.json_response({"status": "error", "message": "No filename provided"})

    # 1. Rutas base
    output_dir = folder_paths.get_output_directory()
    input_dir = folder_paths.get_input_directory()

    # 2. Construir rutas completas
    # Archivo origen en Output
    source_path = os.path.join(output_dir, subfolder, filename) if subfolder else os.path.join(output_dir, filename)
    
    # Crear una subcarpeta "Academia_Edits" en Input para no mezclar las fotos copiadas con las originales
    target_subfolder = "Academia_Edits"
    target_folder = os.path.join(input_dir, target_subfolder)
    os.makedirs(target_folder, exist_ok=True)
    
    # Archivo destino en Input
    target_path = os.path.join(target_folder, filename)

    # 3. Copiar el archivo físicamente
    try:
        if os.path.exists(source_path):
            shutil.copy2(source_path, target_path)
            # Devolvemos la ruta relativa que el nodo Load Image necesita (ej: "Academia_Edits/mi_foto_0001.png")
            relative_target_path = os.path.join(target_subfolder, filename).replace("\\", "/")
            return web.json_response({"status": "success", "target_path": relative_target_path})
        else:
            return web.json_response({"status": "error", "message": "Source file not found in output folder."})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


class AcademiaSaveAndSendNode:
    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE", ),
                "filename_prefix": ("STRING", {"default": "Academia_Edit"}),
                "target_node_title": ("STRING", {"default": "Load Image"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "Academia SD"

    def save_images(self, images, filename_prefix="Academia_Edit", target_node_title="Load Image", prompt=None, extra_pnginfo=None):
        # Guardado ESTÁNDAR de ComfyUI en la carpeta OUTPUT
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(filename_prefix, self.output_dir, images[0].shape[1], images[0].shape[0])
        
        results = list()
        
        for (batch_number, image) in enumerate(images):
            i = 255. * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))
            
            metadata = PngInfo()
            if prompt is not None:
                metadata.add_text("prompt", json.dumps(prompt))
            if extra_pnginfo is not None:
                for x in extra_pnginfo:
                    metadata.add_text(x, json.dumps(extra_pnginfo[x]))

            file = f"{filename}_{counter:05}_.png"
            img.save(os.path.join(full_output_folder, file), pnginfo=metadata, compress_level=4)
            
            results.append({
                "filename": file,
                "subfolder": subfolder,
                "type": self.type
            })
            counter += 1

        print(f"[AcademiaSD] 💾 Saved image to Output folder: {file}")

        return { "ui": { "images": results } }

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_SaveAndSend": AcademiaSaveAndSendNode
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_SaveAndSend": "AcademiaSD Image Save & Send 💾🚀"
}
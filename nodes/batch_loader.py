import os
import folder_paths
from PIL import Image, ImageOps
import numpy as np
import torch

class AcademiaSD_BatchLoader:
    """
    Carga imágenes de una carpeta local de forma secuencial usando un índice.
    """
    
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "folder_path": ("STRING", {"default": "C:\\Ruta\\A\\Tus\\Imagenes"}),
                "image_index": ("INT", {"default": 0, "min": 0, "step": 1}),
            },
            "optional": {
                "filename_filter": ("STRING", {"default": "", "multiline": False}),
            }
        }

    CATEGORY = "AcademiaSD/Dataset"
    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "STRING")
    RETURN_NAMES = ("image", "mask", "image_path", "filename_text")
    FUNCTION = "load_batch_images"

    def load_batch_images(self, folder_path, image_index, filename_filter=""):
        # 1. Validar directorio
        if not os.path.isdir(folder_path):
            if folder_path == "C:\\Ruta\\A\\Tus\\Imagenes":
                print("[AcademiaSD] Ruta por defecto detectada.")
                return (torch.zeros((1,64,64,3)), torch.zeros((64,64)), "", "dummy")
            raise FileNotFoundError(f"La carpeta no existe: {folder_path}")

        # 2. Filtrar archivos
        valid_extensions = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff']
        files = []
        
        for f in sorted(os.listdir(folder_path)):
            ext = os.path.splitext(f)[1].lower()
            if ext not in valid_extensions:
                continue
            if filename_filter and filename_filter not in f:
                continue
            files.append(os.path.join(folder_path, f))

        if not files:
            raise FileNotFoundError("No se encontraron imágenes válidas.")

        # 3. Índice circular
        count = len(files)
        actual_index = image_index % count
        image_path = files[actual_index]
        print(f"[AcademiaSD Loader] Procesando {actual_index + 1}/{count}: {os.path.basename(image_path)}")

        # 4. Cargar
        try:
            i = Image.open(image_path)
            i = ImageOps.exif_transpose(i)
            image = i.convert("RGB")
            image = np.array(image).astype(np.float32) / 255.0
            image = torch.from_numpy(image)[None,]
            
            if 'A' in i.getbands():
                mask = np.array(i.getchannel('A')).astype(np.float32) / 255.0
                mask = 1. - torch.from_numpy(mask)
            else:
                mask = torch.zeros((64,64), dtype=torch.float32, device="cpu")
                
            return (image, mask, image_path, os.path.basename(image_path))
            
        except Exception as e:
            print(f"Error cargando imagen: {e}")
            return (torch.zeros((1,64,64,3)), torch.zeros((64,64)), image_path, "error")

# Registro del nodo (solo para este archivo)
NODE_CLASS_MAPPINGS = {
    "AcademiaSD_BatchLoader": AcademiaSD_BatchLoader
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_BatchLoader": "📂 Batch Image Loader (Dataset)"
}
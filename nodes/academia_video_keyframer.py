import os
import json
import re
import torch
import numpy as np
from PIL import Image, ImageOps
import folder_paths
from server import PromptServer
from aiohttp import web

@PromptServer.instance.routes.get("/academia/input_images")
async def get_input_images(request):
    images = folder_paths.get_filename_list("input")
    return web.json_response(images)

def load_image_as_tensor(image_path):
    if not image_path or not os.path.exists(image_path):
        print(f"[AcademiaSD] ❌ Image not found: {image_path}")
        return torch.zeros((1, 64, 64, 3))
    
    try:
        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        image_tensor = torch.from_numpy(np.array(img).astype(np.float32) / 255.0).unsqueeze(0)
        return image_tensor
    except Exception as e:
        print(f"[AcademiaSD] ❌ Error processing image {image_path}: {e}")
        return torch.zeros((1, 64, 64, 3))

class AcademiaVideoKeyframer:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "output_prefix": ("STRING", {"default": "test/rosaroja"}),
                # --- CAMBIO A FLOAT ---
                "fps": ("FLOAT", {"default": 24.0, "min": 0.1, "max": 240.0, "step": 0.1, "display": "number"}),
                "index": ("INT", {"default": 1, "min": 1, "max": 1000, "step": 1}),
                "kf_data": ("STRING", {"default": "[]"}), 
            }
        }

    # El tercer RETURN_TYPE pasa de "INT" a "FLOAT" para el FPS
    RETURN_TYPES = ("IMAGE", "IMAGE", "FLOAT", "INT", "STRING")
    RETURN_NAMES = ("FF Image", "LF Image", "FPS", "Duration", "Path")
    FUNCTION = "process_keyframes"
    CATEGORY = "Academia SD"

    def process_keyframes(self, output_prefix, fps, index, kf_data="[]"):
        try:
            keyframes = json.loads(kf_data)
        except:
            keyframes =[]

        if len(keyframes) < 2:
            print("[AcademiaSD] ⚠️ Need at least 2 Keyframes to generate video.")
            empty = torch.zeros((1, 64, 64, 3))
            return (empty, empty, fps, 33, output_prefix)

        safe_prefix = output_prefix.replace("\\", "/")
        subfolder = os.path.dirname(safe_prefix)
        file_prefix = os.path.basename(safe_prefix)

        ff_image = None
        lf_image = None
        duration = 33

        if index == 1:
            ff_name = keyframes[0].get("image", "")
            ff_path = folder_paths.get_annotated_filepath(ff_name)
            ff_image = load_image_as_tensor(ff_path)

            lf_name = keyframes[1].get("image", "")
            lf_path = folder_paths.get_annotated_filepath(lf_name)
            lf_image = load_image_as_tensor(lf_path)
            
            duration = int(keyframes[1].get("frames", 33))
            print(f"[AcademiaSD] 🎬 Loop {index}: Base '{ff_name}' -> Target '{lf_name}' (Duration: {duration} frames)")
        else:
            out_dir = folder_paths.get_output_directory()
            search_dir = os.path.join(out_dir, subfolder) if subfolder else out_dir
            
            if os.path.exists(search_dir):
                files = os.listdir(search_dir)
                pattern = re.compile(rf"^{re.escape(file_prefix)}_(\d+)_?\.png$")
                valid_files =[f for f in files if pattern.match(f)]
                
                if valid_files:
                    valid_files.sort(key=lambda x: int(pattern.match(x).group(1)))
                    last_file = os.path.join(search_dir, valid_files[-1])
                    ff_image = load_image_as_tensor(last_file)
                    print(f"[AcademiaSD] 🎬 Loop {index}: Auto-Loaded '{os.path.basename(last_file)}'")
                else:
                    print(f"[AcademiaSD] ⚠️ No frames found matching '{file_prefix}_*.png'. Using base.")
                    ff_image = load_image_as_tensor(folder_paths.get_annotated_filepath(keyframes[0].get("image", "")))

            target_idx = index
            if target_idx < len(keyframes):
                lf_name = keyframes[target_idx].get("image", "")
                lf_path = folder_paths.get_annotated_filepath(lf_name)
                lf_image = load_image_as_tensor(lf_path)
                duration = int(keyframes[target_idx].get("frames", 33))
                print(f"[AcademiaSD] 🎬 Loop {index}: Target is Keyframe {target_idx} '{lf_name}' (Duration: {duration} frames)")
            else:
                lf_name = keyframes[-1].get("image", "")
                lf_path = folder_paths.get_annotated_filepath(lf_name)
                lf_image = load_image_as_tensor(lf_path)
                duration = int(keyframes[-1].get("frames", 33))
                print(f"[AcademiaSD] 🎬 Loop {index}: Reached end. Holding on '{lf_name}' (Duration: {duration} frames)")

        if ff_image is None: ff_image = torch.zeros((1, 64, 64, 3))
        if lf_image is None: lf_image = torch.zeros((1, 64, 64, 3))

        return (ff_image, lf_image, fps, duration, safe_prefix)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_VideoKeyframer": AcademiaVideoKeyframer
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_VideoKeyframer": "Academia SD Keyframe Video 🎞️"
}
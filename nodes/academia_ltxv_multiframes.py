import os
import json
import torch
import numpy as np
import comfy.utils
from PIL import Image, ImageOps
import folder_paths

def load_image_as_tensor(image_path):
    if not image_path or not os.path.exists(image_path):
        return None
    try:
        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        return torch.from_numpy(np.array(img).astype(np.float32) / 255.0).unsqueeze(0)
    except Exception as e:
        print(f"[AcademiaSD] ❌ Error processing image {image_path}: {e}")
        return None

class AcademiaLTXVMultiFrames:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "vae": ("VAE",),
                "latent": ("LATENT",),
                "kf_data": ("STRING", {"default": "[]"}), # JSON Oculto con Imágenes, Index y Strength
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "apply_in_place"
    CATEGORY = "Academia SD"

    def apply_in_place(self, vae, latent, kf_data="[]"):
        try:
            frames = json.loads(kf_data)
        except:
            frames =[]

        if not frames:
            return (latent,)

        print(f"[AcademiaSD] Starting LTXV Multi-Frame Inplace Injection...")

        samples = latent["samples"].clone()
        
        # Obtener los factores de escala (si existen en el VAE de LTX, si no, usar el estándar de LTX-Video)
        scale_factors = getattr(vae, "downscale_index_formula", (8, 32, 32))
        time_scale_factor = scale_factors[0]
        height_scale_factor = scale_factors[1]
        width_scale_factor = scale_factors[2]

        batch, _, latent_frames, latent_height, latent_width = samples.shape
        width = latent_width * width_scale_factor
        height = latent_height * height_scale_factor

        if "noise_mask" in latent:
            conditioning_latent_frames_mask = latent["noise_mask"].clone()
        else:
            conditioning_latent_frames_mask = torch.ones(
                (batch, 1, latent_frames, 1, 1),
                dtype=torch.float32,
                device=samples.device,
            )

        for i, frame in enumerate(frames):
            img_name = frame.get("image", "")
            img_path = folder_paths.get_annotated_filepath(img_name)
            image = load_image_as_tensor(img_path)
            
            if image is None:
                continue

            index = int(frame.get("index", 0))
            strength = float(frame.get("strength", 1.0))

            # Escalar imagen si es necesario
            if image.shape[1] != height or image.shape[2] != width:
                pixels = comfy.utils.common_upscale(image.movedim(-1, 1), width, height, "bilinear", "center").movedim(1, -1)
            else:
                pixels = image
                
            encode_pixels = pixels[:, :, :, :3]
            t = vae.encode(encode_pixels)

            # Matemáticas de frames
            pixel_frame_count = (latent_frames - 1) * time_scale_factor + 1
            if index < 0:
                index = pixel_frame_count + index

            latent_idx = index // time_scale_factor
            latent_idx = max(0, min(latent_idx, latent_frames - 1))
            end_index = min(latent_idx + t.shape[2], latent_frames)

            # Inyectar Latent y Máscara
            samples[:, :, latent_idx:end_index] = t[:, :, :end_index - latent_idx]
            conditioning_latent_frames_mask[:, :, latent_idx:end_index] = 1.0 - strength
            
            print(f"[AcademiaSD] 💉 Injected '{img_name}' at Index {index} (Strength: {strength})")

        return ({"samples": samples, "noise_mask": conditioning_latent_frames_mask},)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_LTXVMultiFrames": AcademiaLTXVMultiFrames
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_LTXVMultiFrames": "Academia SD LTXV Multi-Frames 🖼️"
}
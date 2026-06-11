import torch
import torch.nn.functional as F
import torchvision.transforms.functional as TF

class AcademiaMaskedNoise:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "noise_type": (["Black & White", "Color"], {"default": "Black & White"}),
                # Cambiado a noise_intensity para mayor claridad
                "noise_intensity": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "shrink_pixels": ("INT", {"default": 0, "min": 0, "max": 500, "step": 1}),
                "feather_pixels": ("INT", {"default": 10, "min": 0, "max": 500, "step": 1}),
                "opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "solid_base": ("BOOLEAN", {"default": False, "label_on": "Yes", "label_off": "No"}),
                "solid_opacity": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "solid_color": ("STRING", {"default": "#000000"}), 
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("IMAGE", "PROCESSED_MASK")
    FUNCTION = "apply_noise"
    CATEGORY = "Academia SD"

    def apply_noise(self, image, mask, noise_type, noise_intensity, shrink_pixels, feather_pixels, opacity, solid_base, solid_opacity, solid_color):
        
        if len(mask.shape) == 2:
            mask = mask.unsqueeze(0)
            
        if image.shape[0] != mask.shape[0]:
            mask = mask.expand(image.shape[0], -1, -1)

        mask = mask.unsqueeze(1)
        
        if shrink_pixels > 0:
            kernel_size = shrink_pixels * 2 + 1
            mask = 1.0 - F.max_pool2d(1.0 - mask, kernel_size=kernel_size, stride=1, padding=shrink_pixels)

        if feather_pixels > 0:
            kernel_size = feather_pixels * 2 + 1
            sigma = feather_pixels * 0.5
            mask = TF.gaussian_blur(mask, kernel_size=[kernel_size, kernel_size], sigma=[sigma, sigma])

        # Opacidad controla globalmente cuánto afecta el efecto final
        mask = mask * opacity

        if mask.shape[2] != image.shape[1] or mask.shape[3] != image.shape[2]:
            mask = F.interpolate(mask, size=(image.shape[1], image.shape[2]), mode="bilinear", align_corners=False)

        processed_mask_out = mask.squeeze(1).clone()
        mask_expanded = mask.squeeze(1).unsqueeze(-1)

        # Base Sólida
        if solid_base:
            color_hex = solid_color.lstrip('#')
            if len(color_hex) != 6: color_hex = "000000"
            r = int(color_hex[0:2], 16) / 255.0
            g = int(color_hex[2:4], 16) / 255.0
            b = int(color_hex[4:6], 16) / 255.0
            solid_tensor = torch.tensor([r, g, b], device=image.device).view(1, 1, 1, 3)
            
            # Mezclamos la imagen original con el color sólido en el área de la máscara
            base_image = image * (1.0 - (mask_expanded * solid_opacity)) + solid_tensor * (mask_expanded * solid_opacity)
        else:
            base_image = image

        # Generar Ruido
        if noise_type == "Black & White":
            # Ruido centrado en 0.5 (gris neutro)
            pure_noise = torch.rand((image.shape[0], image.shape[1], image.shape[2], 1), device=image.device)
            pure_noise = pure_noise.repeat(1, 1, 1, 3)
        else:
            pure_noise = torch.rand((image.shape[0], image.shape[1], image.shape[2], 3), device=image.device)

        # MATEMÁTICA CORREGIDA: 
        # Si la opacidad es 1.0, el ruido reemplazará por completo la imagen base.
        # El noise_intensity solo suaviza el grano del ruido (acercándolo al gris neutro 0.5) 
        # pero NO lo hace transparente.
        
        # 1. Suavizamos el contraste interno del ruido
        neutral_grey = torch.full_like(pure_noise, 0.5)
        softened_noise = torch.lerp(neutral_grey, pure_noise, noise_intensity)
        
        # 2. Pegamos la capa de ruido (suave o agresiva) SOBRE la imagen usando la máscara
        final_image = base_image * (1.0 - mask_expanded) + softened_noise * mask_expanded

        return (final_image, processed_mask_out)

NODE_CLASS_MAPPINGS = {
    "AcademiaSD_MaskedNoise": AcademiaMaskedNoise
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_MaskedNoise": "Academia SD Masked Noise 🌫️"
}
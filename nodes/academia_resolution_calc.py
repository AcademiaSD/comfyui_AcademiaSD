import math
import folder_paths
import server
import os
from aiohttp import web
from PIL import Image

class AcademiaResolutionCalc:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        ratios = [
            # Lo elige "Get Size from Image" cuando la imagen de referencia no
            # encaja en ninguna proporcion de la lista, y asi el desplegable
            # dice de verdad que ratio esta en uso.
            "Custom",
            "1:1 (Perfect Square)", "2:3 (Classic Portrait)", "3:4 (Golden Ratio)", 
            "3:5 (Elegant Vertical)", "4:5 (Artistic Frame)", "5:7 (Balanced Portrait)", 
            "5:8 (Tall Portrait)", "7:9 (Modern Portrait)", "9:16 (Slim Vertical)", 
            "9:19 (Tall Slim)", "9:21 (Ultra Tall)", "9:32 (Skyline)", 
            "3:2 (Golden Landscape)", "4:3 (Classic Landscape)", "5:3 (Wide Horizon)", 
            "5:4 (Balanced Frame)", "7:5 (Elegant Landscape)", "8:5 (Cinematic View)", 
            "9:7 (Artful Horizon)", "16:9 (Panorama)", "19:9 (Cinematic Ultrawide)", 
            "21:9 (Epic Ultrawide)", "32:9 (Extreme Ultrawide)"
        ]
        return {
            "required": {
                "megapixel": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 100.0, "step": 0.1}),
                "aspect_ratio": (ratios, {"default": "4:5 (Artistic Frame)"}),
                "divisible_by": (["8", "16", "32", "64"], {"default": "16"}),
                # label_on es lo que se ENSEÑA cuando el valor es True. Con
                # "Enable"/"Disable" el nodo ponia "Enable" justo mientras el
                # ratio manual estaba actuando, que se lee como "esta apagado".
                "custom_ratio": ("BOOLEAN", {"default": False, "label_on": "Custom ON", "label_off": "Custom OFF"}),
                "custom_aspect_ratio": ("STRING", {"default": "1:1"}),
            },
            "optional": { "image": ("IMAGE",) }
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("WIDTH", "HEIGHT")
    FUNCTION = "calc_resolution"
    CATEGORY = "Academia SD"

    @staticmethod
    def _parse_ratio(text, field):
        raw = str(text).strip().replace("/", ":")
        parts = [p.strip() for p in raw.split(":") if p.strip()]
        if len(parts) != 2:
            raise ValueError(
                "Academia Resolution Calc: {} must look like W:H, got {!r}."
                .format(field, text))
        try:
            w_r, h_r = float(parts[0]), float(parts[1])
        except ValueError:
            raise ValueError(
                "Academia Resolution Calc: {} must be two numbers, got {!r}."
                .format(field, text))
        if w_r <= 0 or h_r <= 0:
            raise ValueError(
                "Academia Resolution Calc: {} must be positive, got {!r}."
                .format(field, text))
        return w_r, h_r

    def calc_resolution(self, megapixel, aspect_ratio, divisible_by, custom_ratio, custom_aspect_ratio, image=None):
        # El desplegable y el interruptor son dos caras del mismo ajuste. Basta
        # con que cualquiera de los dos pida ratio manual para usarlo: si alguna
        # vez se descuadran, el nodo no calcula en silencio con una proporcion
        # que no es la que se ve.
        if custom_ratio or str(aspect_ratio).strip().startswith("Custom"):
            w_r, h_r = self._parse_ratio(custom_aspect_ratio, "custom_aspect_ratio")
        else:
            w_r, h_r = self._parse_ratio(str(aspect_ratio).split(" ")[0], "aspect_ratio")

        target_area = megapixel * 1048576
        ratio = w_r / h_r
        h_exact = math.sqrt(target_area / ratio)
        w_exact = h_exact * ratio

        div = int(divisible_by)
        w_final = max(div, int(round(w_exact / div) * div))
        h_final = max(div, int(round(h_exact / div) * div))
        return (w_final, h_final)

# Registro de ruta seguro
routes = server.PromptServer.instance.routes
@routes.get("/academia_res/get_image_size")
async def get_image_size(request):
    filename = request.rel_url.query.get("filename")
    if not filename: return web.json_response({"error": "No filename"}, status=400)
    image_path = folder_paths.get_annotated_filepath(filename)
    if not image_path or not os.path.exists(image_path): return web.json_response({"error": "Not found"}, status=404)
    try:
        with Image.open(image_path) as img:
            return web.json_response({"width": img.width, "height": img.height})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

NODE_CLASS_MAPPINGS = { "AcademiaSD_ResolutionCalc": AcademiaResolutionCalc }
NODE_DISPLAY_NAME_MAPPINGS = { "AcademiaSD_ResolutionCalc": "Academia SD Resolution Calc 🧮" }
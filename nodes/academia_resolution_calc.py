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
                # El minimo baja de 0.1 a 0.0039 (64x64) para que escribir el ancho
                # y el alto a mano funcione en TODO el rango del nodo: 0.1 MP dejaba
                # fuera tamanos tan normales como 320x320. Ampliar un minimo no
                # invalida ningun workflow: los valores que ya se guardaban siguen
                # dentro del rango.
                "megapixel": ("FLOAT", {"default": 1.0, "min": 0.0039, "max": 100.0, "step": 0.1}),
                "aspect_ratio": (ratios, {"default": "4:5 (Artistic Frame)"}),
                "divisible_by": (["8", "16", "32", "64"], {"default": "16"}),
                # label_on es lo que se ENSEÑA cuando el valor es True. Con
                # "Enable"/"Disable" el nodo ponia "Enable" justo mientras el
                # ratio manual estaba actuando, que se lee como "esta apagado".
                "custom_ratio": ("BOOLEAN", {"default": False, "label_on": "Custom ON", "label_off": "Custom OFF"}),
                "custom_aspect_ratio": ("STRING", {"default": "1:1"}),
            },
            "optional": { "image": ("IMAGE",) },
            # unique_id no es un widget ni desplaza nada: hace falta para poder
            # decirle al panel de ESTE nodo que tamano ha llegado de verdad.
            "hidden": { "unique_id": "UNIQUE_ID" },
        }

    # RESOLUTION va la ULTIMA a proposito. Los enlaces guardados en un workflow
    # apuntan al slot por NUMERO, asi que anadir al final deja WIDTH en el 0 y
    # HEIGHT en el 1: quien ya tenga el nodo cableado no tiene que tocar nada.
    RETURN_TYPES = ("INT", "INT", "INT")
    RETURN_NAMES = ("WIDTH", "HEIGHT", "RESOLUTION")
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

    def calc_resolution(self, megapixel, aspect_ratio, divisible_by, custom_ratio,
                        custom_aspect_ratio, image=None, unique_id=None):
        # El unico sitio donde se sabe el tamano de una IMAGE cualquiera es aqui:
        # en el navegador solo se puede averiguar si el origen nombra un fichero,
        # y eso deja fuera todo lo que venga de un VAE Decode, un upscaler o un
        # batch. Peor: con un reescalado por medio, el fichero de origen da un
        # tamano que ya no es el que llega. Asi que se manda el de verdad.
        if image is not None and unique_id is not None:
            try:
                server.PromptServer.instance.send_sync(
                    "academia.rescalc.image_size",
                    {"node_id": str(unique_id),
                     "width": int(image.shape[2]), "height": int(image.shape[1])})
            except Exception:
                pass        # que un aviso de interfaz no tumbe una generacion

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

        # RESOLUTION dice los mismos megapixeles, pero como el lado del cuadrado
        # que ocuparia esa area: 1.0 MP -> 1024, 2.0 MP -> 1448. Es el numero que
        # los modelos llaman "resolucion base". Sale del area PEDIDA, no de
        # w_final x h_final, para que no baile al cambiar aspect_ratio o
        # divisible_by: con megapixel = 1.0 son 1024 y punto.
        resolution = int(round(math.sqrt(target_area)))
        return (w_final, h_final, resolution)

# Registro de ruta seguro
routes = server.PromptServer.instance.routes
ALLOWED_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")

@routes.get("/academia_res/get_image_size")
async def get_image_size(request):
    filename = request.rel_url.query.get("filename")
    if not filename:
        return web.json_response({"error": "No filename"}, status=400)

    # Only image files may be opened through this endpoint.
    if not filename.lower().split("?")[0].endswith(ALLOWED_IMAGE_EXTS):
        return web.json_response({"error": "Invalid file type"}, status=400)

    try:
        # get_annotated_filepath() rejects paths escaping the base directory,
        # but it raises instead of returning, so it must run inside the try.
        image_path = folder_paths.get_annotated_filepath(filename)
        if not image_path or not os.path.exists(image_path):
            return web.json_response({"error": "Not found"}, status=404)
        with Image.open(image_path) as img:
            return web.json_response({"width": img.width, "height": img.height})
    except Exception:
        # Never echo the exception text: it leaks absolute paths.
        return web.json_response({"error": "Invalid request"}, status=400)

NODE_CLASS_MAPPINGS = { "AcademiaSD_ResolutionCalc": AcademiaResolutionCalc }
NODE_DISPLAY_NAME_MAPPINGS = { "AcademiaSD_ResolutionCalc": "Academia SD Resolution Calc 🧮" }
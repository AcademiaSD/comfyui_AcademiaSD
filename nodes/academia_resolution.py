import os
import folder_paths
import server
from aiohttp import web
from PIL import Image

class AcademiaResolutionSelector:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "preset": (["1024x1024", "848x1264", "1264x848", "768x1376", "896x1200", "1376x768", "1200x896", "Custom"], {"default": "1024x1024"}),
                "width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
            },
            "optional": {
                "image": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("WIDTH", "HEIGHT")
    FUNCTION = "get_resolution"
    CATEGORY = "Academia SD"

    def get_resolution(self, preset, width, height, image=None):
        return (width, height)

@server.PromptServer.instance.routes.get("/academia/get_image_size")
async def get_image_size(request):
    filename = request.rel_url.query.get("filename")
    if not filename: return web.json_response({"error": "No filename"}, status=400)
    image_path = folder_paths.get_annotated_filepath(filename)
    try:
        with Image.open(image_path) as img:
            return web.json_response({"width": img.width, "height": img.height})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

NODE_CLASS_MAPPINGS = { "AcademiaSD_Resolution": AcademiaResolutionSelector }
NODE_DISPLAY_NAME_MAPPINGS = { "AcademiaSD_Resolution": "Academia SD Resolution Selector 🖥️" }
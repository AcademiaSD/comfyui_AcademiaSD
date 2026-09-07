"""Publica el icono del canal para que los nodos del paquete lo lleven pintado
en la barra de titulo.

Aqui solo se sirve el fichero: quien lo dibuja es js/academia_branding.js.
Hace falta esta ruta porque WEB_DIRECTORY apunta a js/ y el icono vive en
assets/, que no se sirve solo.
"""

import os

from aiohttp import web
from server import PromptServer

_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ASSETS = os.path.join(_PKG_ROOT, "assets")

# Por nombre exacto primero. La busqueda de despues existe para que renombrar
# el fichero no deje a todos los nodos sin marca sin que nadie se entere.
_PREFERRED = ("icono_Academia.png", "icono_academia.png", "icon_academia.png")


def find_icon():
    """Ruta del icono, o None si no hay ninguno en assets/."""
    for name in _PREFERRED:
        path = os.path.join(_ASSETS, name)
        if os.path.isfile(path):
            return path
    try:
        for name in sorted(os.listdir(_ASSETS)):
            low = name.lower()
            if low.endswith(".png") and ("icono" in low or "icon" in low):
                return os.path.join(_ASSETS, name)
    except OSError:
        pass
    return None


@PromptServer.instance.routes.get("/academia/brand_icon.png")
async def brand_icon(request):
    path = find_icon()
    if not path:
        return web.json_response(
            {"error": "No Academia SD icon found in assets/."}, status=404)
    # El navegador lo cachea un dia; al cambiar el PNG basta con un Ctrl+F5.
    return web.FileResponse(path, headers={"Cache-Control": "max-age=86400"})


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

import os
import asyncio
import requests
import urllib.parse
import re
from server import PromptServer
from aiohttp import web
import folder_paths

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

ACTIVE_DOWNLOADS = set()

def get_filename_from_url(url):
    try:
        response = requests.get(url, stream=True, allow_redirects=True, headers=HEADERS, timeout=15)
        cd = response.headers.get('Content-Disposition')
        if cd:
            fname = re.findall('filename="?([^"]+)"?', cd)
            if len(fname) > 0:
                return fname[0]
                
        parsed = urllib.parse.urlparse(response.url)
        name = os.path.basename(parsed.path)
        return name if name else "descarga_desconocida.safetensors"
    except Exception as e:
        print(f"[AcademiaSD] Error obteniendo nombre del modelo: {e}")
        return None

def get_smart_folder_path(folder_name):
    paths = folder_paths.get_folder_paths(folder_name)
    if not paths: return None
    target_path = paths[0]
    for p in paths:
        if os.path.basename(os.path.normpath(p)) == folder_name:
            target_path = p
            break
    return target_path

def background_download_task(url, file_path):
    temp_path = file_path + ".temp"
    try:
        # CREA LA SUBCARPETA SI NO EXISTE
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        
        with requests.get(url, stream=True, allow_redirects=True, headers=HEADERS) as r:
            r.raise_for_status()
            with open(temp_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=1024*1024):
                    if chunk:
                        f.write(chunk)
        
        os.replace(temp_path, file_path)
        print(f"[AcademiaSD] ✅ Descarga completada: {file_path}")
    except Exception as e:
        print(f"[AcademiaSD] ❌ Error en la descarga de {url}: {e}")
        if os.path.exists(temp_path):
            os.remove(temp_path)
    finally:
        ACTIVE_DOWNLOADS.discard(url)

@PromptServer.instance.routes.get("/academia/folders")
async def get_folders(request):
    folders = list(folder_paths.folder_names_and_paths.keys())
    return web.json_response(folders)

@PromptServer.instance.routes.post("/academia/check")
async def check_file(request):
    data = await request.json()
    url = data.get("url")
    folder = data.get("folder")
    subfolder = data.get("subfolder", "").strip()
    
    if not url or not folder:
        return web.json_response({"status": "error", "exists": False})

    folder_path = get_smart_folder_path(folder)
    if not folder_path:
        return web.json_response({"status": "error", "exists": False})

    # Si hay subcarpeta, la unimos a la ruta (evitando que suban directorios con "..")
    if subfolder:
        safe_subfolder = subfolder.replace("..", "").strip("\\/")
        folder_path = os.path.join(folder_path, safe_subfolder)

    filename = await asyncio.to_thread(get_filename_from_url, url)
    if not filename:
        return web.json_response({"status": "error", "exists": False})

    file_path = os.path.join(folder_path, filename)
    exists = os.path.exists(file_path)
    is_downloading = url in ACTIVE_DOWNLOADS

    return web.json_response({
        "status": "success", 
        "exists": exists, 
        "filename": filename,
        "is_downloading": is_downloading
    })

@PromptServer.instance.routes.post("/academia/download")
async def download_file(request):
    data = await request.json()
    url = data.get("url")
    folder = data.get("folder")
    subfolder = data.get("subfolder", "").strip()
    
    if url in ACTIVE_DOWNLOADS:
        return web.json_response({"status": "started", "message": "Ya se está descargando."})

    folder_path = get_smart_folder_path(folder)
    if not folder_path:
        return web.json_response({"status": "error", "message": "No se encontró la ruta de destino."})

    if subfolder:
        safe_subfolder = subfolder.replace("..", "").strip("\\/")
        folder_path = os.path.join(folder_path, safe_subfolder)

    filename = await asyncio.to_thread(get_filename_from_url, url)
    file_path = os.path.join(folder_path, filename)

    if os.path.exists(file_path):
        return web.json_response({"status": "exists", "message": "El archivo ya existe."})

    ACTIVE_DOWNLOADS.add(url)
    asyncio.create_task(asyncio.to_thread(background_download_task, url, file_path))
    
    return web.json_response({"status": "started"})


class AcademiaDownloaderNode:
    def __init__(self): pass
    @classmethod
    def INPUT_TYPES(s): return {"required": {}}
    RETURN_TYPES = ()
    FUNCTION = "do_nothing"
    CATEGORY = "Academia SD"
    OUTPUT_NODE = True
    def do_nothing(self): return ()

NODE_CLASS_MAPPINGS = {"AcademiaSD_Downloader": AcademiaDownloaderNode}
NODE_DISPLAY_NAME_MAPPINGS = {"AcademiaSD_Downloader": "Academia SD Automatic downloader ⬇️"}
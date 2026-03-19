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
        return name if name else "unknown_download.safetensors"
    except Exception as e:
        print(f"[AcademiaSD] Error getting model name: {e}")
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
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with requests.get(url, stream=True, allow_redirects=True, headers=HEADERS) as r:
            r.raise_for_status()
            with open(temp_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=1024*1024):
                    if chunk:
                        f.write(chunk)
        
        os.replace(temp_path, file_path)
        print(f"[AcademiaSD] ✅ Download completed: {file_path}")
    except Exception as e:
        print(f"[AcademiaSD] ❌ Error downloading {url}: {e}")
        if os.path.exists(temp_path):
            os.remove(temp_path)
    finally:
        ACTIVE_DOWNLOADS.discard(url)

# --- API ROUTES ---

@PromptServer.instance.routes.get("/academia/folders")
async def get_folders(request):
    folders = list(folder_paths.folder_names_and_paths.keys())
    return web.json_response(folders)

@PromptServer.instance.routes.post("/academia/parse_url")
async def parse_url(request):
    data = await request.json()
    url = data.get("url", "")
    
    if "huggingface.co" in url and "/resolve/" not in url and "/blob/" not in url:
        match = re.search(r"huggingface\.co/([^/]+/[^/?#]+)(?:/tree/([^/?#]+))?", url)
        if match:
            repo_id = match.group(1)
            branch = match.group(2) if match.group(2) else "main"
            
            api_url = f"https://huggingface.co/api/models/{repo_id}"
            try:
                response = await asyncio.to_thread(requests.get, api_url, headers=HEADERS, timeout=10)
                if response.status_code == 200:
                    data = response.json()
                    siblings = data.get("siblings", [])
                    valid_exts = (".safetensors", ".gguf", ".ckpt", ".pt", ".bin", ".pth", ".onnx", ".sft")
                    files = []
                    
                    for s in siblings:
                        fname = s["rfilename"]
                        if fname.endswith(valid_exts):
                            direct_url = f"https://huggingface.co/{repo_id}/resolve/{branch}/{fname}"
                            files.append({"name": fname, "url": direct_url})
                    
                    if files:
                        return web.json_response({"status": "success", "type": "repo", "files": files})
            except Exception as e:
                print(f"[AcademiaSD] Error fetching files from HF API: {e}")
                
    return web.json_response({"status": "success", "type": "direct", "url": url})


@PromptServer.instance.routes.post("/academia/check")
async def check_file(request):
    data = await request.json()
    url = data.get("url")
    folder = data.get("folder")
    subfolder = data.get("subfolder", "").strip()
    
    if not url or not folder or url == "none":
        return web.json_response({"status": "error", "exists": False})

    folder_path = get_smart_folder_path(folder)
    if not folder_path:
        return web.json_response({"status": "error", "exists": False})

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
        return web.json_response({"status": "started", "message": "Already downloading."})

    folder_path = get_smart_folder_path(folder)
    if not folder_path:
        return web.json_response({"status": "error", "message": "Target path not found."})

    if subfolder:
        safe_subfolder = subfolder.replace("..", "").strip("\\/")
        folder_path = os.path.join(folder_path, safe_subfolder)

    filename = await asyncio.to_thread(get_filename_from_url, url)
    file_path = os.path.join(folder_path, filename)

    if os.path.exists(file_path):
        return web.json_response({"status": "exists", "message": "File already exists."})

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
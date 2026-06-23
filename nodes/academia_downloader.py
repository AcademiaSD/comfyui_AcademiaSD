import os
import asyncio
import requests
import urllib.parse
import re
import json
import math
from server import PromptServer
from aiohttp import web
import folder_paths

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

ACTIVE_DOWNLOADS = {}
TOKENS_FILE = os.path.join(folder_paths.base_path, "models", "academia_tokens.json")
PRESETS_DIR = os.path.join(folder_paths.base_path, "models", "academia_presets")
os.makedirs(PRESETS_DIR, exist_ok=True)
URL_INFO_CACHE = {} 

def format_size(size_bytes):
    try:
        size_bytes = int(size_bytes)
        if size_bytes == 0: return "0 B"
        size_name = ("B", "KB", "MB", "GB", "TB")
        i = int(math.floor(math.log(size_bytes, 1024))) if size_bytes > 0 else 0
        p = math.pow(1024, i)
        s = round(size_bytes / p, 2)
        return f"{s} {size_name[i]}"
    except:
        return "Unknown"

def get_headers_with_auth(url, civitai_token="", hf_token=""):
    req_headers = HEADERS.copy()
    if "civitai.com" in url and civitai_token:
        req_headers["Authorization"] = f"Bearer {civitai_token}"
    elif "huggingface.co" in url and hf_token:
        req_headers["Authorization"] = f"Bearer {hf_token}"
    return req_headers

def get_file_info_from_url(url, civitai_token="", hf_token=""):
    if not url or not url.startswith(('http://', 'https://')):
        return None, "0 B"
        
    if url in URL_INFO_CACHE:
        return URL_INFO_CACHE[url]["filename"], URL_INFO_CACHE[url]["size"]

    try:
        req_headers = get_headers_with_auth(url, civitai_token, hf_token)
        response = requests.get(url, stream=True, allow_redirects=True, headers=req_headers, timeout=8)
        response.close()
        
        if response.status_code in [401, 403] or "civitai.com/login" in response.url:
            return None, "Auth Required"

        size_bytes = response.headers.get('Content-Length')
        formatted_size = format_size(size_bytes) if size_bytes else "Unknown"

        fname = None
        cd = response.headers.get('Content-Disposition')
        if cd:
            match = re.search(r'filename=["\']?([^;"\']+)', cd)
            if match: fname = os.path.basename(match.group(1).strip())
            
        if not fname:
            parsed = urllib.parse.urlparse(response.url)
            fname = os.path.basename(parsed.path)
            if not fname or fname.isdigit():
                fname = (fname if fname else "model") + ".safetensors"

        URL_INFO_CACHE[url] = {"filename": fname, "size": formatted_size}
        return fname, formatted_size
    except Exception as e:
        return None, "Unknown"

def find_existing_file(folder_name, subfolder, filename):
    paths = folder_paths.get_folder_paths(folder_name)
    if not paths: return None
    for base_path in paths:
        check_path = base_path
        if subfolder:
            check_path = os.path.join(check_path, subfolder.replace("..", "").strip("\\/"))
        full_file_path = os.path.join(check_path, filename)
        if os.path.exists(full_file_path):
            return full_file_path
    return None

def get_download_target_path(folder_name, subfolder):
    paths = folder_paths.get_folder_paths(folder_name)
    target_base = paths[0] if paths else os.path.join(folder_paths.base_path, "models", folder_name)
    for p in paths or []:
        if os.path.basename(os.path.normpath(p)) == folder_name:
            target_base = p
            break
    if subfolder:
        target_base = os.path.join(target_base, subfolder.replace("..", "").strip("\\/"))
    return target_base

def background_download_task(url, file_path, civitai_token="", hf_token=""):
    temp_path = file_path + ".temp"
    try:
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        req_headers = get_headers_with_auth(url, civitai_token, hf_token)
        with requests.get(url, stream=True, allow_redirects=True, headers=req_headers) as r:
            r.raise_for_status()
            total_length = r.headers.get('content-length')
            total_length = int(total_length) if total_length else 0
            downloaded = 0
            
            with open(temp_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=1024*1024): 
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total_length > 0:
                            ACTIVE_DOWNLOADS[url] = {"progress": int((downloaded / total_length) * 100)}
        
        os.replace(temp_path, file_path)
    except Exception as e:
        if os.path.exists(temp_path): os.remove(temp_path)
    finally:
        ACTIVE_DOWNLOADS.pop(url, None)

# --- RUTAS API ---
@PromptServer.instance.routes.get("/academia/tokens")
async def get_tokens(request):
    if os.path.exists(TOKENS_FILE):
        try:
            with open(TOKENS_FILE, "r") as f: return web.json_response(json.load(f))
        except: pass
    return web.json_response({"civitai": "", "huggingface": ""})

@PromptServer.instance.routes.post("/academia/tokens")
async def save_tokens(request):
    data = await request.json()
    try:
        with open(TOKENS_FILE, "w") as f:
            json.dump({"civitai": data.get("civitai", ""), "huggingface": data.get("huggingface", "")}, f)
        return web.json_response({"status": "success"})
    except Exception as e: return web.json_response({"status": "error", "message": str(e)})

@PromptServer.instance.routes.get("/academia/download_presets")
async def get_download_presets(request):
    name = request.query.get("name")
    if name:
        filepath = os.path.join(PRESETS_DIR, f"{name}.json")
        if os.path.exists(filepath):
            with open(filepath, "r", encoding="utf-8") as f: return web.json_response({"status": "success", "data": json.load(f)})
        return web.json_response({"status": "error", "message": "Preset not found"})
    files = [f[:-5] for f in os.listdir(PRESETS_DIR) if f.endswith(".json")]
    return web.json_response({"status": "success", "files": files})

@PromptServer.instance.routes.post("/academia/download_presets")
async def save_download_preset(request):
    data = await request.json()
    name = data.get("name")
    if not name: return web.json_response({"status": "error", "message": "No name provided"})
    safe_name = "".join(c for c in name if c.isalnum() or c in (' ', '-', '_')).rstrip()
    try:
        with open(os.path.join(PRESETS_DIR, f"{safe_name}.json"), "w", encoding="utf-8") as f:
            json.dump(data.get("data", []), f, indent=4)
        return web.json_response({"status": "success"})
    except Exception as e: return web.json_response({"status": "error", "message": str(e)})

@PromptServer.instance.routes.get("/academia/folders")
async def get_folders(request):
    raw_folders = list(folder_paths.folder_names_and_paths.keys())
    for ef in ["checkpoints", "unet", "diffusion_models", "loras", "vae", "text_encoders", "clip", "controlnet", "upscale_models", "embeddings"]:
        if ef not in raw_folders: raw_folders.append(ef)
    raw_folders.sort()
    return web.json_response(raw_folders)

@PromptServer.instance.routes.post("/academia/parse_url")
async def parse_url(request):
    data = await request.json()
    url = data.get("url", "")
    hf_token = data.get("hf_token", "")
    if "huggingface.co" in url and "/resolve/" not in url and "/blob/" not in url:
        match = re.search(r"huggingface\.co/([^/]+/[^/?#]+)(?:/tree/([^/?#]+))?", url)
        if match:
            repo_id, branch = match.group(1), match.group(2) or "main"
            headers = HEADERS.copy()
            if hf_token: headers["Authorization"] = f"Bearer {hf_token}"
            try:
                res = await asyncio.to_thread(requests.get, f"https://huggingface.co/api/models/{repo_id}", headers=headers, timeout=10)
                if res.status_code == 200:
                    files = [{"name": os.path.basename(s["rfilename"]), "url": f"https://huggingface.co/{repo_id}/resolve/{branch}/{s['rfilename']}", "size": format_size(s.get("size"))} 
                             for s in res.json().get("siblings", []) if s["rfilename"].endswith((".safetensors", ".gguf", ".ckpt", ".pt", ".bin", ".pth", ".onnx", ".sft"))]
                    if files: return web.json_response({"status": "success", "type": "repo", "files": files})
            except: pass
    return web.json_response({"status": "success", "type": "direct", "url": url})

@PromptServer.instance.routes.post("/academia/check")
async def check_file(request):
    data = await request.json()
    url = data.get("url", "").strip() 
    folder = data.get("folder")
    subfolder = data.get("subfolder", "").strip()
    filename_hint = data.get("filename", "").strip() 
    civ_t, hf_t = data.get("civitai_token", "").strip(), data.get("hf_token", "").strip()
    
    if not url or url == "none": return web.json_response({"status": "error", "exists": False})

    if url in ACTIVE_DOWNLOADS:
        return web.json_response({"status": "success", "exists": False, "is_downloading": True, "progress": ACTIVE_DOWNLOADS[url].get("progress", -1)})

    filename = os.path.basename(filename_hint) if filename_hint else ""
    filesize = "Unknown"

    if not filename or filename in ["Direct Link", "Pending..."]:
        filename, filesize = await asyncio.to_thread(get_file_info_from_url, url, civ_t, hf_t)
        if not filename: return web.json_response({"status": "error", "exists": False, "message": "auth_required", "filesize": filesize})

    existing_file = find_existing_file(folder, subfolder, filename)
    exists = existing_file is not None

    if exists:
        try: filesize = format_size(os.path.getsize(existing_file))
        except: pass
        URL_INFO_CACHE[url] = {"filename": filename, "size": filesize}
    else:
        # ¡BUGFIX! Forzamos siempre a leer el tamaño si no existe, sin importar si el nombre ya lo sabíamos.
        real_fname, real_fsize = await asyncio.to_thread(get_file_info_from_url, url, civ_t, hf_t)
        if real_fsize and real_fsize != "Unknown":
            filesize = real_fsize
            
        if real_fname and real_fname != filename:
            filename = os.path.basename(real_fname)
            exists = find_existing_file(folder, subfolder, filename) is not None
            if exists:
                try: filesize = format_size(os.path.getsize(find_existing_file(folder, subfolder, filename)))
                except: pass

    return web.json_response({"status": "success", "exists": exists, "filename": filename, "filesize": filesize, "is_downloading": False})

@PromptServer.instance.routes.post("/academia/download")
async def download_file(request):
    data = await request.json()
    url = data.get("url", "").strip()
    folder, subfolder = data.get("folder"), data.get("subfolder", "").strip()
    filename = data.get("filename", "").strip()
    civ_t, hf_t = data.get("civitai_token", "").strip(), data.get("hf_token", "").strip()
    
    if not url: return web.json_response({"status": "error", "message": "Invalid URL."})
    if url in ACTIVE_DOWNLOADS: return web.json_response({"status": "started", "message": "Already downloading."})

    filename = os.path.basename(filename) if filename else ""
    if not filename or filename in ["Direct Link", "Pending..."]:
        filename, _ = await asyncio.to_thread(get_file_info_from_url, url, civ_t, hf_t)
        if not filename: return web.json_response({"status": "error", "message": "Auth required or invalid link."})

    if find_existing_file(folder, subfolder, filename):
        return web.json_response({"status": "exists", "message": "File already exists."})

    file_path = os.path.join(get_download_target_path(folder, subfolder), filename)
    ACTIVE_DOWNLOADS[url] = {"progress": 0}
    asyncio.create_task(asyncio.to_thread(background_download_task, url, file_path, civ_t, hf_t))
    
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
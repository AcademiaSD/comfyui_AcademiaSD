import os
import math  # <- ¡Librería matemática añadida!
import asyncio
import requests
import urllib.parse
import re
import json
from server import PromptServer
from aiohttp import web
import folder_paths

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

ACTIVE_DOWNLOADS = {}
TOKENS_FILE = os.path.join(folder_paths.base_path, "models", "academia_tokens.json")
URL_INFO_CACHE = {} 

def format_size(size_bytes):
    try:
        size_bytes = int(size_bytes)
        if size_bytes == 0: return "0 B"
        size_name = ("B", "KB", "MB", "GB", "TB")
        # Corrección del cálculo matemático
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
        return "invalid_link", "0 B"
        
    if url in URL_INFO_CACHE:
        return URL_INFO_CACHE[url]["filename"], URL_INFO_CACHE[url]["size"]

    try:
        req_headers = get_headers_with_auth(url, civitai_token, hf_token)
        response = requests.get(url, stream=True, allow_redirects=True, headers=req_headers, timeout=8)
        response.close()
        
        if response.status_code in [401, 403] or "civitai.com/login" in response.url:
            return None, "Auth Required"
        if "text/html" in response.headers.get("Content-Type", "") and "civitai.com" in url:
            return None, "Auth Required"

        size_bytes = response.headers.get('Content-Length')
        formatted_size = format_size(size_bytes) if size_bytes else "Unknown"

        fname = None
        cd = response.headers.get('Content-Disposition')
        if cd:
            match = re.findall('filename="?([^"]+)"?', cd)
            if match: fname = match[0]
            
        if not fname:
            parsed = urllib.parse.urlparse(response.url)
            fname = os.path.basename(parsed.path)
            if not fname or fname.isdigit():
                fname = (fname if fname else "model") + ".safetensors"

        URL_INFO_CACHE[url] = {"filename": fname, "size": formatted_size}
        return fname, formatted_size

    except requests.exceptions.Timeout:
        parsed = urllib.parse.urlparse(url)
        fname = os.path.basename(parsed.path)
        if not fname or fname.isdigit(): fname = (fname if fname else "model") + ".safetensors"
        return fname, "Unknown"
    except Exception as e:
        return "unknown_error.safetensors", "Unknown"

def find_existing_file(folder_name, subfolder, filename):
    paths = folder_paths.get_folder_paths(folder_name)
    if not paths: return None
        
    for base_path in paths:
        check_path = base_path
        if subfolder:
            safe_subfolder = subfolder.replace("..", "").strip("\\/")
            check_path = os.path.join(check_path, safe_subfolder)
            
        full_file_path = os.path.join(check_path, filename)
        if os.path.exists(full_file_path):
            return full_file_path
    return None

def get_download_target_path(folder_name, subfolder):
    paths = folder_paths.get_folder_paths(folder_name)
    target_base = None
    if paths:
        for p in paths:
            if os.path.basename(os.path.normpath(p)) == folder_name:
                target_base = p
                break
        if not target_base: target_base = paths[0]
    else:
        try:
            base_models_dir = folder_paths.get_folder_paths("checkpoints")[0]
            target_base = os.path.join(os.path.dirname(base_models_dir), folder_name)
        except:
            target_base = os.path.join(folder_paths.base_path, "models", folder_name)

    if subfolder:
        safe_subfolder = subfolder.replace("..", "").strip("\\/")
        target_base = os.path.join(target_base, safe_subfolder)
    return target_base

def background_download_task(url, file_path, civitai_token="", hf_token=""):
    temp_path = file_path + ".temp"
    try:
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        req_headers = get_headers_with_auth(url, civitai_token, hf_token)
        
        with requests.get(url, stream=True, allow_redirects=True, headers=req_headers) as r:
            r.raise_for_status()
            total_length = r.headers.get('content-length')
            
            if total_length is None:
                ACTIVE_DOWNLOADS[url] = {"progress": -1} 
            else:
                total_length = int(total_length)
                ACTIVE_DOWNLOADS[url] = {"progress": 0}
            
            downloaded = 0
            with open(temp_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=1024*1024): 
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total_length:
                            ACTIVE_DOWNLOADS[url]["progress"] = int((downloaded / total_length) * 100)
        
        os.replace(temp_path, file_path)
        print(f"[AcademiaSD] ✅ Download completed: {file_path}")
    except Exception as e:
        print(f"[AcademiaSD] ❌ Error downloading {url}: {e}")
        if os.path.exists(temp_path):
            os.remove(temp_path)
    finally:
        ACTIVE_DOWNLOADS.pop(url, None)

# --- API ROUTES ---

@PromptServer.instance.routes.get("/academia/tokens")
async def get_tokens(request):
    try:
        if os.path.exists(TOKENS_FILE):
            with open(TOKENS_FILE, "r") as f:
                return web.json_response(json.load(f))
    except: pass
    return web.json_response({"civitai": "", "huggingface": ""})

@PromptServer.instance.routes.post("/academia/tokens")
async def save_tokens(request):
    data = await request.json()
    try:
        with open(TOKENS_FILE, "w") as f:
            json.dump({"civitai": data.get("civitai", ""), "huggingface": data.get("huggingface", "")}, f)
        return web.json_response({"status": "success"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})

@PromptServer.instance.routes.get("/academia/folders")
async def get_folders(request):
    raw_folders = list(folder_paths.folder_names_and_paths.keys())
    essential_folders = ["checkpoints", "unet", "diffusion_models", "loras", "vae", "text_encoders", "clip", "controlnet", "upscale_models", "embeddings"]
    for ef in essential_folders:
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
            repo_id = match.group(1)
            branch = match.group(2) if match.group(2) else "main"
            api_url = f"https://huggingface.co/api/models/{repo_id}"
            
            headers = HEADERS.copy()
            if hf_token: headers["Authorization"] = f"Bearer {hf_token}"
            
            try:
                response = await asyncio.to_thread(requests.get, api_url, headers=headers, timeout=10)
                if response.status_code == 200:
                    data = response.json()
                    siblings = data.get("siblings", [])
                    valid_exts = (".safetensors", ".gguf", ".ckpt", ".pt", ".bin", ".pth", ".onnx", ".sft")
                    
                    files = []
                    for s in siblings:
                        fname = s["rfilename"]
                        if fname.endswith(valid_exts):
                            f_size = format_size(s.get("size"))
                            files.append({
                                "name": fname, 
                                "url": f"https://huggingface.co/{repo_id}/resolve/{branch}/{fname}",
                                "size": f_size
                            })
                    if files: return web.json_response({"status": "success", "type": "repo", "files": files})
            except Exception: pass
    return web.json_response({"status": "success", "type": "direct", "url": url})

@PromptServer.instance.routes.post("/academia/check")
async def check_file(request):
    data = await request.json()
    url = data.get("url", "").strip()
    folder = data.get("folder")
    subfolder = data.get("subfolder", "").strip()
    civitai_token = data.get("civitai_token", "").strip()
    hf_token = data.get("hf_token", "").strip()
    
    if not url or url == "none" or not url.startswith(('http://', 'https://')):
        return web.json_response({"status": "error", "exists": False})

    if url in ACTIVE_DOWNLOADS:
        progress = ACTIVE_DOWNLOADS[url].get("progress", -1)
        return web.json_response({
            "status": "success", "exists": False, 
            "is_downloading": True, "progress": progress
        })

    filename, filesize = await asyncio.to_thread(get_file_info_from_url, url, civitai_token, hf_token)
    if not filename:
        return web.json_response({"status": "error", "exists": False, "message": "auth_required", "filesize": filesize})

    existing_file = find_existing_file(folder, subfolder, filename)
    exists = existing_file is not None

    if exists:
        try:
            local_size_bytes = os.path.getsize(existing_file)
            filesize = format_size(local_size_bytes)
            if url in URL_INFO_CACHE:
                URL_INFO_CACHE[url]["size"] = filesize
        except Exception:
            pass

    return web.json_response({
        "status": "success", "exists": exists, 
        "filename": filename, "filesize": filesize,
        "is_downloading": False
    })

@PromptServer.instance.routes.post("/academia/download")
async def download_file(request):
    data = await request.json()
    url = data.get("url", "").strip()
    folder = data.get("folder")
    subfolder = data.get("subfolder", "").strip()
    civitai_token = data.get("civitai_token", "").strip()
    hf_token = data.get("hf_token", "").strip()
    
    if not url or not url.startswith(('http://', 'https://')):
        return web.json_response({"status": "error", "message": "Invalid URL."})

    if url in ACTIVE_DOWNLOADS:
        return web.json_response({"status": "started", "message": "Already downloading."})

    filename, filesize = await asyncio.to_thread(get_file_info_from_url, url, civitai_token, hf_token)
    if not filename:
        return web.json_response({"status": "error", "message": "Auth required or invalid link."})

    existing_file = find_existing_file(folder, subfolder, filename)
    if existing_file:
        return web.json_response({"status": "exists", "message": "File already exists."})

    target_dir = get_download_target_path(folder, subfolder)
    file_path = os.path.join(target_dir, filename)

    ACTIVE_DOWNLOADS[url] = {"progress": 0}
    asyncio.create_task(asyncio.to_thread(background_download_task, url, file_path, civitai_token, hf_token))
    
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
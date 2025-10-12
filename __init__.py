import sys
from pathlib import Path
import importlib.util
import traceback

# ======================================================
# 🌟 Common version for all comfyui_AcademiaSD nodes
# ======================================================
__version__ = "1.2.3"
print(f"[AcademiaSD Loader] Loading comfyui_AcademiaSD v{__version__}")
# ======================================================

try:
    current_path = Path(__file__)
    comfyui_root_path = current_path.parent.parent.parent
    if str(comfyui_root_path) not in sys.path:
        print(f"[AcademiaSD Loader] Adding ComfyUI root path to sys.path: {comfyui_root_path}")
        sys.path.insert(0, str(comfyui_root_path))
except Exception as e:
    print(f"[AcademiaSD Loader] Error adding ComfyUI root path to sys.path: {e}")

try:
    import comfy
    print("[AcademiaSD Loader] Successfully pre-imported the 'comfy' module.")
except Exception as e:
    print(f"[AcademiaSD Loader] Warning: Could not pre-import 'comfy'. Node imports may fail. Error: {e}")


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def load_module(module_name: str, file_path: str):
    """Loads a Python module from a .py file path using importlib."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not create module spec for {module_name} at {file_path}")
    module = importlib.util.module_from_spec(spec)
    if module_name not in sys.modules:
        sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _module_name_for(path: Path, base_pkg: str, nodes_path: Path) -> str:
    """Converts a file path to a package-like module name (e.g., nodes.sub.module)."""
    rel = path.relative_to(nodes_path)
    parts = list(rel.with_suffix('').parts)
    return ".".join([base_pkg] + parts) if parts else base_pkg


def load_nodes():
    """
    Loads all .py modules from the 'nodes' directory and its subdirectories.
    """
    base_pkg = "nodes"
    nodes_path = Path(__file__).parent / base_pkg

    if not nodes_path.is_dir():
        print(f"[AcademiaSD Loader] The '{nodes_path}' directory does not exist.")
        return

    py_files = [file for file in nodes_path.rglob("*.py") if not (file.name == "__init__.py" and file.parent == nodes_path)]
    py_files.sort(key=lambda p: str(p.relative_to(nodes_path)))

    for file in py_files:
        try:
            module_name = _module_name_for(file, "comfyui_academiasd.nodes", nodes_path)
            module = load_module(module_name, str(file))

            if hasattr(module, "NODE_CLASS_MAPPINGS") and isinstance(module.NODE_CLASS_MAPPINGS, dict):
                for k, v in module.NODE_CLASS_MAPPINGS.items():
                    if k in NODE_CLASS_MAPPINGS:
                        print(f"[AcademiaSD Loader] Warning: Duplicate key '{k}' in NODE_CLASS_MAPPINGS from module '{module_name}'. Overwriting.")
                    NODE_CLASS_MAPPINGS[k] = v

            if hasattr(module, "NODE_DISPLAY_NAME_MAPPINGS") and isinstance(module.NODE_DISPLAY_NAME_MAPPINGS, dict):
                for k, v in module.NODE_DISPLAY_NAME_MAPPINGS.items():
                    if k in NODE_DISPLAY_NAME_MAPPINGS:
                        print(f"[AcademiaSD Loader] Warning: Duplicate key '{k}' in NODE_DISPLAY_NAME_MAPPINGS from module '{module_name}'. Overwriting.")
                    NODE_DISPLAY_NAME_MAPPINGS[k] = v

        except Exception as e:
            rel_path = file.relative_to(nodes_path)
            print(f"[AcademiaSD Loader] Error loading node from {rel_path}: {e}\n{traceback.format_exc()}")


load_nodes()

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]

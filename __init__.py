import importlib.util
import sys
from pathlib import Path
import traceback

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

def load_module(module_name, file_path):
    """Loads a module from a .py file."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def load_nodes():
    """Loads nodes from the nodes folder."""
    nodes_path = Path(__file__).parent / 'nodes'
    for file in nodes_path.glob("*.py"):
        if file.name != "__init__.py":
            try:
                module = load_module(f"nodes.{file.stem}", str(file))
                NODE_CLASS_MAPPINGS.update(getattr(module, 'NODE_CLASS_MAPPINGS', {}))
                NODE_DISPLAY_NAME_MAPPINGS.update(getattr(module, 'NODE_DISPLAY_NAME_MAPPINGS', {}))
            except Exception as e:
                print(f"Error loading {file.name}: {e}\n{traceback.format_exc()}")

# Execute functions
load_nodes()

WEBDIRECTORY = "./js"
_all = ["NODE_CLASS_MAPPINGS", 'NODE_DISPLAY_NAME_MAPPINGS', "WEB_DIRECTORY"]

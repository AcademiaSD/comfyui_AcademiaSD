import importlib.util
import sys
from pathlib import Path
import traceback

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

def load_module(module_name: str, file_path: str):
    """Carga un módulo desde un archivo .py usando importlib."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"No se pudo crear spec para {module_name} ({file_path})")
    module = importlib.util.module_from_spec(spec)
    # Evita imports duplicados si se vuelve a cargar
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module

def _module_name_for(path: Path, base_pkg: str, nodes_path: Path) -> str:
    """Convierte una ruta a nombre de módulo tipo paquete (nodes.sub.paquete.modulo)."""
    rel = path.relative_to(nodes_path)  # p.ej. 'sub/paquete/modulo.py'
    parts = list(rel.with_suffix('').parts)  # ['sub','paquete','modulo']
    return ".".join([base_pkg] + parts) if parts else base_pkg

def load_nodes():
    """
    Carga todos los módulos .py dentro de 'nodes' y sus subcarpetas,
    incluyendo __init__.py de subpaquetes (excepto el __init__ de la raíz).
    Combina NODE_CLASS_MAPPINGS y NODE_DISPLAY_NAME_MAPPINGS si están definidos.
    """
    base_pkg = "nodes"
    nodes_path = Path(__file__).parent / base_pkg

    if not nodes_path.is_dir():
        print(f"[load_nodes] Carpeta '{nodes_path}' no existe.")
        return

    # rglob para recorrer recursivamente. Incluimos __init__.py de subpaquetes,
    # pero omitimos el __init__.py del paquete raíz 'nodes'.
    py_files = []
    for file in nodes_path.rglob("*.py"):
        if file.name == "__init__.py" and file.parent == nodes_path:
            continue  # omitimos el __init__ raíz de 'nodes'
        py_files.append(file)

    # Orden estable para reproducibilidad (ruta relativa)
    py_files.sort(key=lambda p: str(p.relative_to(nodes_path)))

    for file in py_files:
        try:
            module_name = _module_name_for(file, base_pkg, nodes_path)
            module = load_module(module_name, str(file))

            # Extraer y fusionar los mapeos si existen
            mod_class_map = getattr(module, "NODE_CLASS_MAPPINGS", {})
            if isinstance(mod_class_map, dict) and mod_class_map:
                # Advertir si hay colisiones
                for k in mod_class_map.keys():
                    if k in NODE_CLASS_MAPPINGS:
                        print(f"[load_nodes] Advertencia: clave duplicada '{k}' en NODE_CLASS_MAPPINGS "
                              f"(módulo {module_name}). Se sobrescribirá.")
                NODE_CLASS_MAPPINGS.update(mod_class_map)

            mod_display_map = getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {})
            if isinstance(mod_display_map, dict) and mod_display_map:
                for k in mod_display_map.keys():
                    if k in NODE_DISPLAY_NAME_MAPPINGS:
                        print(f"[load_nodes] Advertencia: clave duplicada '{k}' en NODE_DISPLAY_NAME_MAPPINGS "
                              f"(módulo {module_name}). Se sobrescribirá.")
                NODE_DISPLAY_NAME_MAPPINGS.update(mod_display_map)

        except Exception as e:
            rel = file.relative_to(nodes_path)
            print(f"[load_nodes] Error cargando {rel}: {e}\n{traceback.format_exc()}")

# Ejecutar la carga
load_nodes()

# Config web: corregimos el nombre y lo exportamos bien
WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

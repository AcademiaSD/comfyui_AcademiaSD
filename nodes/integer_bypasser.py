# integer_bypasser.py

# Try to import the shared version from comfyui_AcademiaSD
try:
    from .. import __version__ as ACADEMIASD_VERSION
except Exception:
    ACADEMIASD_VERSION = "1.0.0"  # fallback local version


class IntegerBypasser:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "in1": ("LATENT",),
                "in2": ("LATENT",),
                "in3": ("LATENT",),
                "in4": ("LATENT",),
            },
            "optional": {
                "active_count": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 64,
                    "step": 1,
                    "display": "number",
                    "tooltip": "Active bypass (0 = all off, 1 = Only one, etc.)",
                    "forceInput": False  
                }),
            }
        }

    RETURN_TYPES = ()  
    FUNCTION = "execute"
    CATEGORY = "AcademiaSD/Bypass"

    INPUT_ORDER = ["active_count", "in1", "in2", "in3", "in4"]

    def execute(self, active_count=0, in1=None, in2=None, in3=None, in4=None, **kwargs):
        print(f"[IntegerBypasser v{ACADEMIASD_VERSION}] active_count={active_count}")
        return {}


NODE_CLASS_MAPPINGS = {
    "IntegerBypasser": IntegerBypasser,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "IntegerBypasser": f"Integer Bypasser v{ACADEMIASD_VERSION} (AcademiaSD)",
}

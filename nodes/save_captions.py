import os

class AcademiaSD_SaveCaption:
    """
    Guarda el caption generado en un .txt junto a la imagen original.
    """

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "generated_caption": ("STRING", {"forceInput": True}),
                "image_path": ("STRING", {"forceInput": True}), 
                "extra_text": ("STRING", {"multiline": False, "default": "trigger_word"}),
                "text_position": (["Start (Prefix)", "End (Suffix)"], {"default": "Start (Prefix)"}),
                "separator": ("STRING", {"default": ", "}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("final_saved_text",)
    FUNCTION = "save_dataset_caption"
    OUTPUT_NODE = True
    CATEGORY = "AcademiaSD/Dataset"

    def save_dataset_caption(self, generated_caption, image_path, extra_text, text_position, separator):
        final_text = ""
        extra_text = extra_text.strip()
        generated_caption = generated_caption.strip()

        # Lógica de prefijo/sufijo
        if extra_text == "":
            final_text = generated_caption
        else:
            if text_position == "Start (Prefix)":
                final_text = f"{extra_text}{separator}{generated_caption}"
            else:
                final_text = f"{generated_caption}{separator}{extra_text}"

        # Validar ruta
        if not image_path or not os.path.exists(image_path):
            print(f"\033[91m[AcademiaSD Saver] Error: Ruta inválida: {image_path}\033[0m")
            return (final_text,)

        # Generar ruta TXT
        base_path = os.path.splitext(image_path)[0]
        txt_path = base_path + ".txt"

        # Guardar
        try:
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(final_text)
            print(f"\033[92m[AcademiaSD Saver] Guardado: {os.path.basename(txt_path)}\033[0m")
        except Exception as e:
            print(f"\033[91m[AcademiaSD Saver] Error escribiendo fichero: {e}\033[0m")

        return (final_text,)

# Registro del nodo (solo para este archivo)
NODE_CLASS_MAPPINGS = {
    "AcademiaSD_SaveCaption": AcademiaSD_SaveCaption
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_SaveCaption": "💾 Save Dataset Caption (.txt)"
}
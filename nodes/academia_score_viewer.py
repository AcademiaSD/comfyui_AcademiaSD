"""Score Viewer: dibuja en el nodo la partitura ABC de YuE2 o SheetSage2.

El dibujo y el sonido van en el navegador (js/academia_score_viewer.js) con
abcjs, incluido en js/abcjs (MIT, Paul Rosen y Gregory Dyke).

Draws the ABC score from YuE2 or SheetSage2 inside the node. Rendering and
playback live in the browser, with abcjs bundled in js/abcjs.
"""

import torch

from comfy_api.latest import IO, UI
TRAMAS_POR_SEGUNDO = 20  # js/academia_score_core.js usa la misma cifra
VENTANA = 8192


def cromagrama(waveform, rate):
    """Energia de cada nota (tiempo x 12) para situar la partitura en el audio.
    Comparar notas y no ataques evita caer varios pulsos antes o despues."""
    mono = waveform.mean(0).cpu()
    espectro = torch.stft(mono, VENTANA, rate // TRAMAS_POR_SEGUNDO, window=torch.hann_window(VENTANA), return_complex=True).abs() ** 2
    freq = torch.fft.rfftfreq(VENTANA, 1 / rate)
    banda = (freq >= 80) & (freq <= 2000)
    nota = ((12 * torch.log2(freq[banda] / 440)).round().long() + 9) % 12
    croma = torch.zeros(12, espectro.shape[1]).index_add_(0, nota, espectro[banda])
    croma = torch.log1p(croma / croma.mean())
    return (croma.t() * 255 / croma.max()).round().byte()


class AcademiaScoreViewer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"abc": ("STRING", {"forceInput": True})},
            "optional": {"audio": ("AUDIO", {"tooltip": "The generated song. Play then follows it instead of the built-in synth."})},
        }

    RETURN_TYPES = ()
    FUNCTION = "show"
    OUTPUT_NODE = True
    CATEGORY = "Academia SD/YuE2"
    DESCRIPTION = "Shows an ABC score as sheet music, with playback synced to the song, transposition and note names."

    def show(self, abc, audio=None):
        ui = {"abc": [abc]}
        if audio is not None:
            # FLAC: el MP3 anade relleno al inicio y descuadraria la sincronia.
            ui["sync_audio"] = UI.AudioSaveHelper.save_audio(audio, "asd_score", IO.FolderType.temp, None)[:1]
            ui["chroma"] = [cromagrama(audio["waveform"][0], audio["sample_rate"]).flatten().tolist()]
        return {"ui": ui}


NODE_CLASS_MAPPINGS = {
    "AcademiaSD_ScoreViewer": AcademiaScoreViewer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AcademiaSD_ScoreViewer": "Academia SD Score Viewer 🎼",
}

# comfyui_AcademiaSD
# Official set of custom nodes of AcademiaSD.

ComfyUI and ForgeWebUI tutorial in my Youtube channel [@Academia SD](https://www.youtube.com/@Academia_SD)

Loop Tools
Instructions in the video https://www.youtube.com/watch?v=vACeuxv5HIw

Bypass nodes by value
Instructions in the video https://www.youtube.com/watch?v=4Ya_NuEB0Rs

Gemini Vision 1.1.2
Instructions in the video https://www.youtube.com/watch?v=7WJanKUaSEE
Dataset captions included

 Automatic Downloader 0.99

Multilora injection 0.6
Using official lora injection, native method or using clip method

Numeric to Int&Float 

Image Save & Send

## Academia SD Resolution Selector for ComfyUI 0.9
![](./assets/Resolution_Selector.png)
A utility node for ComfyUI designed to make image resolution management fast, precise, and user-friendly. Whether you are working with SDXL or SD 1.5 models, this node provides a clean interface to calculate and set your dimensions.
Features
Quick Presets: Easily select common resolutions for SDXL/SD 1.5 with a single click.
Manual Control: Full control over width and height with built-in validation (rounds to the nearest multiple of 8 to ensure model compatibility).
Workflow Utilities:
Half (➗): Quickly halve the resolution.
Double (✖️): Quickly double the resolution.
Swap (🔄): Instantly swap width and height.
Get Size (📐): A unique feature that reads the dimensions of an input image (from a Load Image node) and automatically updates the Width and Height widgets.
Smart State: If you manually edit the width or height, the preset selector automatically switches to "Custom," keeping your workflow organized.

Workflows included.

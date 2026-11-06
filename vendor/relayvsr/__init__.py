"""Port of RelayVSR (https://github.com/kopperx/RelayVSR), Apache-2.0, to ComfyUI.

Adapted for ComfyUI: inference paths only, comfy.ops layers so ComfyUI can offload
the weights, no diffusers/accelerate/einops, and pure PyTorch attention instead of
the upstream Triton kernels, which cannot be compiled on a portable Windows Python.
"""

import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.ResolutionCalc",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_ResolutionCalc") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const megapixelW = this.widgets.find(w => w.name === "megapixel");
                const aspectRatioW = this.widgets.find(w => w.name === "aspect_ratio");
                const divisibleW = this.widgets.find(w => w.name === "divisible_by");
                const customRatioW = this.widgets.find(w => w.name === "custom_ratio");
                const customAspectW = this.widgets.find(w => w.name === "custom_aspect_ratio");

                const container = document.createElement("div");
                container.style.cssText = `
                    width: 100%; display: flex; justify-content: center; align-items: center;
                    padding: 10px; box-sizing: border-box; background: #111; 
                    border-radius: 6px; border: 1px solid #444; margin-top: 10px;
                    box-shadow: inset 0 0 10px rgba(0,0,0,0.8);
                `;

                const resLabel = document.createElement("div");
                resLabel.style.cssText = "color: #00ff00; font-size: 18px; font-weight: bold; font-family: monospace; text-shadow: 0 0 5px #00ff00;";
                resLabel.innerText = "1024 x 1024";
                container.appendChild(resLabel);

                // Replicamos la matemática exacta de Python para la pantalla en vivo
                const updateResolution = () => {
                    if (!megapixelW || !aspectRatioW || !divisibleW || !customRatioW || !customAspectW) return;

                    const mp = parseFloat(megapixelW.value);
                    const div = parseInt(divisibleW.value);
                    const isCustom = customRatioW.value;

                    let w_r = 1.0, h_r = 1.0;

                    if (isCustom) {
                        const parts = customAspectW.value.split(":");
                        if (parts.length === 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]))) {
                            w_r = parseFloat(parts[0]);
                            h_r = parseFloat(parts[1]);
                        }
                    } else {
                        const ratioStr = aspectRatioW.value.split(" ")[0];
                        const parts = ratioStr.split(":");
                        if (parts.length === 2) {
                            w_r = parseFloat(parts[0]);
                            h_r = parseFloat(parts[1]);
                        }
                    }

                    if (w_r <= 0 || h_r <= 0 || isNaN(w_r) || isNaN(h_r)) {
                        resLabel.innerText = "Error: Invalid Ratio";
                        return;
                    }

                    const targetArea = mp * 1000000;
                    const ratio = w_r / h_r;
                    const h_exact = Math.sqrt(targetArea / ratio);
                    const w_exact = h_exact * ratio;

                    const w_final = Math.max(div, Math.round(w_exact / div) * div);
                    const h_final = Math.max(div, Math.round(h_exact / div) * div);

                    resLabel.innerText = `${w_final} x ${h_final}`;
                };

                const widgetsToWatch = [megapixelW, aspectRatioW, divisibleW, customRatioW, customAspectW];
                widgetsToWatch.forEach(w => {
                    if (w) {
                        const originalCallback = w.callback;
                        w.callback = function() {
                            if (originalCallback) originalCallback.apply(this, arguments);
                            updateResolution();
                        };
                    }
                });

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("Display", "HTML", container);

                // --- GESTIÓN MATEMÁTICA RÍGIDA DEL TAMAÑO ---
                const MIN_WIDTH = 320;
                const originalComputeSize = this.computeSize;
                
                this.computeSize = function(out) {
                    let size = originalComputeSize ? originalComputeSize.apply(this, arguments) : [MIN_WIDTH, 150];
                    size[1] += 65; // Sumamos la altura del recuadro verde LED
                    size[0] = Math.max(size[0], MIN_WIDTH);
                    return size;
                };

                const originalOnResize = this.onResize;
                this.onResize = function(size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    const minSize = this.computeSize();
                    if (size[1] < minSize[1]) size[1] = minSize[1];
                    if (size[0] < minSize[0]) size[0] = minSize[0];
                };

                setTimeout(() => {
                    updateResolution();
                    const minSize = this.computeSize();
                    this.setSize([Math.max(this.size[0], MIN_WIDTH), minSize[1]]);
                }, 100);
            };
        }
    }
});
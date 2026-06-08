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
                    width: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center;
                    padding: 8px; box-sizing: border-box; background: #111; 
                    border-radius: 6px; border: 1px solid #444; margin-top: 10px;
                    box-shadow: inset 0 0 10px rgba(0,0,0,0.8);
                `;

                const resLabel = document.createElement("div");
                // Ajustado ligeramente el tamaño de fuente para que encaje bien al comprimirlo al máximo
                resLabel.style.cssText = "color: #00ff00; font-size: 16px; font-weight: bold; font-family: monospace; text-shadow: 0 0 5px #00ff00; white-space: nowrap;";
                resLabel.innerText = "1024 x 1024";
                
                const actualMpLabel = document.createElement("div");
                actualMpLabel.style.cssText = "color: #888; font-size: 11px; margin-top: 4px; font-family: monospace; white-space: nowrap;";
                actualMpLabel.innerText = "(Real: 1.00 MP)";

                container.appendChild(resLabel);
                container.appendChild(actualMpLabel);

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
                        actualMpLabel.innerText = "--";
                        return;
                    }

                    // Matemáticas Binarias para IA (1024 x 1024 = 1048576)
                    const targetArea = mp * 1048576;
                    const ratio = w_r / h_r;
                    
                    const h_exact = Math.sqrt(targetArea / ratio);
                    const w_exact = h_exact * ratio;

                    const w_final = Math.max(div, Math.round(w_exact / div) * div);
                    const h_final = Math.max(div, Math.round(h_exact / div) * div);

                    // Calcular cuántos MP reales han quedado tras forzar la divisibilidad
                    const real_mp = (w_final * h_final) / 1048576;

                    resLabel.innerText = `${w_final} x ${h_final}`;
                    actualMpLabel.innerText = `(Real: ${real_mp.toFixed(2)} MP)`;
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

                // --- NUEVO TAMAÑO MÍNIMO MÁS COMPACTO ---
                const MIN_WIDTH = 240; 
                const originalComputeSize = this.computeSize;
                
                this.computeSize = function(out) {
                    let size = originalComputeSize ? originalComputeSize.apply(this, arguments) : [MIN_WIDTH, 150];
                    size[1] += 65; // Altura del recuadro verde LED + Subtítulo gris
                    
                    // Devolvemos SIEMPRE el MIN_WIDTH absoluto para permitir encoger libremente
                    return [MIN_WIDTH, size[1]];
                };

                const originalOnResize = this.onResize;
                this.onResize = function(size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    const minSize = this.computeSize();
                    // Protegemos el alto rígidamente
                    if (size[1] < minSize[1]) size[1] = minSize[1];
                    // Y ahora el ancho puede bajar hasta 240px
                    if (size[0] < minSize[0]) size[0] = minSize[0];
                };

                setTimeout(() => {
                    updateResolution();
                    const minSize = this.computeSize();
                    // Al cargar el nodo, si el usuario no lo ha estirado, se quedará en su tamaño más compacto
                    this.setSize([Math.max(this.size[0], MIN_WIDTH), minSize[1]]);
                }, 100);
            };
        }
    }
});
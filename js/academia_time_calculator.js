import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.TimeCalculator",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_TimeCalculator") {
            
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                // Localizamos las cajas de entrada
                const framesWidget = this.widgets.find(w => w.name === "frames");
                const fpsWidget = this.widgets.find(w => w.name === "fps");

                // Creamos el letrero digital
                const container = document.createElement("div");
                container.style.cssText = `
                    width: 100%; display: flex; justify-content: center; align-items: center;
                    padding: 8px; box-sizing: border-box; background: #111; 
                    border-radius: 6px; border: 1px solid #444; margin-top: 10px;
                    box-shadow: inset 0 0 10px rgba(0,0,0,0.8);
                `;

                const timeLabel = document.createElement("div");
                timeLabel.style.cssText = "color: #00ff00; font-size: 16px; font-weight: bold; font-family: monospace; text-shadow: 0 0 5px #00ff00;";
                timeLabel.innerText = "Duration: 0.0s";

                container.appendChild(timeLabel);

                // Función matemática de cálculo en Javascript
                const updateTime = () => {
                    if (framesWidget && fpsWidget) {
                        const frames = parseInt(framesWidget.value);
                        const fps = parseFloat(fpsWidget.value);
                        
                        if (!isNaN(frames) && !isNaN(fps) && fps > 0) {
                            const seconds = (frames / fps).toFixed(2);
                            timeLabel.innerText = `⏱️ ${seconds}s`;
                        } else {
                            timeLabel.innerText = `⏱️ Error`;
                        }
                    }
                };

                // Enganchamos nuestra función al evento "cuando el usuario cambia el número"
                if (framesWidget) {
                    const originalFramesCallback = framesWidget.callback;
                    framesWidget.callback = function() {
                        if (originalFramesCallback) originalFramesCallback.apply(this, arguments);
                        updateTime();
                    };
                }

                if (fpsWidget) {
                    const originalFpsCallback = fpsWidget.callback;
                    fpsWidget.callback = function() {
                        if (originalFpsCallback) originalFpsCallback.apply(this, arguments);
                        updateTime();
                    };
                }

                // Prevenir que al arrastrar el ratón sobre el letrero muevas el nodo sin querer
                container.addEventListener("mousedown", (e) => e.stopPropagation());
                
                // Inyectar el letrero en el nodo
                this.addDOMWidget("Display", "HTML", container);

                // --- 🛡️ LA CORRECCIÓN EXACTA DEL TAMAÑO (MÁS ESTRECHO) 🛡️ ---
                const MIN_WIDTH = 180; // Reducido de 260 a 180 para que sea "de bolsillo"
                
                this.computeSize = function(out) {
                    let baseH = 80; 
                    let htmlH = 60; // Ajustado ligeramente el alto para que cuadre con el nuevo ancho
                    
                    return [MIN_WIDTH, baseH + htmlH];
                };

                const originalOnResize = this.onResize;
                this.onResize = function(size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    const minSize = this.computeSize();
                    
                    if (size[1] < minSize[1]) size[1] = minSize[1];
                    if (size[0] < minSize[0]) size[0] = minSize[0];
                };

                // Actualizar por primera vez al crear el nodo
                setTimeout(() => {
                    updateTime();
                    const minSize = this.computeSize();
                    this.setSize([Math.max(this.size[0], MIN_WIDTH), minSize[1]]);
                }, 100);
            };
        }
    }
});
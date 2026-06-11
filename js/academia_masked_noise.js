import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.MaskingTools",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_MaskedNoise") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const colorWidget = this.widgets.find(w => w.name === "solid_color");
                if (colorWidget) {
                    colorWidget.type = "hidden";
                    colorWidget.computeSize = () => [0, -4]; 
                    colorWidget.draw = function() {}; 
                }

                const container = document.createElement("div");
                container.style.cssText = `
                    width: 100%; display: flex; align-items: center; justify-content: space-between;
                    padding: 4px 8px; box-sizing: border-box; background: rgba(0,0,0,0.3); 
                    border-radius: 4px; border: 1px solid #444; margin-top: 2px;
                    height: 28px; /* Altura más reducida */
                `;

                const label = document.createElement("span");
                label.innerText = "Solid Base Color:";
                label.style.cssText = "color: #ccc; font-size: 12px; font-weight: bold; font-family: sans-serif;";

                const colorInput = document.createElement("input");
                colorInput.type = "color";
                colorInput.value = colorWidget ? colorWidget.value : "#000000";
                colorInput.style.cssText = "width: 40px; height: 20px; border: 1px solid #555; border-radius: 3px; cursor: pointer; background: transparent; padding: 0;";

                colorInput.addEventListener("input", (e) => {
                    if (colorWidget) colorWidget.value = e.target.value;
                    app.graph.setDirtyCanvas(true, false);
                });

                container.appendChild(label);
                container.appendChild(colorInput);

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("ColorUI", "HTML", container);
                
                const MIN_WIDTH = 260; 
                const originalComputeSize = this.computeSize;
                
                this.computeSize = function(out) {
                    let size = originalComputeSize ? originalComputeSize.apply(this, arguments) : [MIN_WIDTH, 150];
                    
                    // CORRECCIÓN: Sumamos EXACTAMENTE 28 píxeles de altura del HTML y nada de padding extra fantasma.
                    let finalHeight = size[1] + 28; 
                    
                    return [MIN_WIDTH, finalHeight];
                };

                const originalOnResize = this.onResize;
                this.onResize = function(size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    const minSize = this.computeSize();
                    
                    if (size[1] < minSize[1]) size[1] = minSize[1];
                    if (size[0] < minSize[0]) size[0] = minSize[0];
                };

                setTimeout(() => {
                    const minSize = this.computeSize();
                    this.setSize([Math.max(this.size[0], MIN_WIDTH), minSize[1]]);
                }, 50);
            };
        }
    }
});
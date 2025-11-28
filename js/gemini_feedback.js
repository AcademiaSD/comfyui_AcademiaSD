import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

app.registerExtension({
    name: "AcademiaSD.GeminiStyling",
    
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_Gemini_Node") {
            
            // 1. ESTILIZAR CAJAS DE ENTRADA (Input)
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const widgetsToCompact = ["prefix_prompt", "main_prompt", "suffix_prompt"];

                if (this.widgets) {
                    for (const w of this.widgets) {
                        if (widgetsToCompact.includes(w.name)) {
                            // CERO MÁRGENES: Pegamos las cajas unas a otras
                            w.inputEl.style.marginBottom = "0px"; 
                            w.inputEl.style.marginTop = "0px";
                            w.inputEl.style.borderRadius = "0px"; // Bordes cuadrados para que encajen mejor
                            
                            // Si es la primera caja, le damos borde redondeado arriba
                            if (w.name === "prefix_prompt") {
                                w.inputEl.style.borderTopLeftRadius = "4px";
                                w.inputEl.style.borderTopRightRadius = "4px";
                            }

                            // Cajas pequeñas (Prefijo/Sufijo)
                            if (w.name !== "main_prompt") {
                                w.computeSize = function(width) {
                                    return [width, 50]; 
                                };
                                w.inputEl.style.height = "45px";
                                w.inputEl.style.maxHeight = "45px";
                                w.inputEl.style.minHeight = "45px";
                                w.inputEl.style.color = "#777"; // Gris para diferenciar instrucciones
                                w.inputEl.style.fontSize = "11px";
                            }
                        }
                    }
                }
                
                setTimeout(() => { this.onResize?.(this.size); }, 50);
            };

            // 2. CAJA DE RESULTADO (Output)
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                onExecuted?.apply(this, arguments);

                if (message?.text) {
                    const text = message.text[0];
                    const widgetName = "Gemini Response";
                    
                    let widget = this.widgets.find(w => w.name === widgetName);

                    if (!widget) {
                        const w = ComfyWidgets["STRING"](this, widgetName, ["STRING", { multiline: true }], app).widget;
                        w.inputEl.readOnly = true;
                        
                        // ESTILO TERMINAL HACKER
                        w.inputEl.style.backgroundColor = "#050505"; // Casi negro total
                        w.inputEl.style.color = "#00ff41";           // Verde Matrix
                        w.inputEl.style.fontFamily = "Consolas, 'Courier New', monospace";
                        w.inputEl.style.fontSize = "12px";
                        w.inputEl.style.padding = "10px";
                        
                        // BORDES Y MÁRGENES (Aquí está el arreglo del hueco)
                        w.inputEl.style.border = "1px solid #333";
                        w.inputEl.style.borderTop = "1px dashed #00ff41"; // Línea decorativa arriba
                        w.inputEl.style.marginTop = "0px"; // <--- ESTO ELIMINA EL HUECO
                        w.inputEl.style.borderRadius = "0px";
                        w.inputEl.style.borderBottomLeftRadius = "4px";
                        w.inputEl.style.borderBottomRightRadius = "4px";
                        
                        // TAMAÑO Y SCROLL
                        w.inputEl.style.height = "350px";
                        w.inputEl.style.maxHeight = "350px";
                        w.inputEl.style.overflowY = "auto";
                        
                        w.computeSize = function(width) {
                            return [width, 370];
                        };
                        
                        widget = w;
                    }
                    
                    widget.value = text;
                    this.onResize?.(this.size);
                    app.graph.setDirtyCanvas(true, true);
                }
            };
        }
    }
});
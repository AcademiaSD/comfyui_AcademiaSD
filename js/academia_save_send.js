import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js"; // Importamos la API nativa de ComfyUI

app.registerExtension({
    name: "AcademiaSD.SaveAndSend",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_SaveAndSend") {
            
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function(message) {
                if (onExecuted) onExecuted.apply(this, arguments);

                if (message && message.images && message.images.length > 0) {
                    this.lastSavedFilename = message.images[0].filename;
                    this.lastSavedSubfolder = message.images[0].subfolder || "";

                    if (!this.sendButtonWidget) {
                        this.sendButtonWidget = this.addWidget("button", "🚀 SEND TO EDIT", "button", async () => {
                            if (!this.lastSavedFilename) return;

                            const targetTitleWidget = this.widgets.find(w => w.name === "target_node_title");
                            const targetTitle = targetTitleWidget ? targetTitleWidget.value : "Load Image";

                            // 1. Buscamos el nodo destino
                            const targetNode = app.graph._nodes.find(n => n.title === targetTitle || n.type === targetTitle);

                            if (!targetNode) {
                                alert(`[Academia SD] ❌ Could not find a node titled "${targetTitle}".\nPlease rename your Load Image node to "${targetTitle}" (Right click -> Title).`);
                                return;
                            }

                            // 2. Como recibe la imagen ese nodo. Los que guardan su
                            // estado en un JSON -- Multi Image Reference -- no tienen
                            // widget "image", asi que primero se les pregunta y solo
                            // despues se husmean los widgets.
                            const puedeRecibir = typeof targetNode.asdReceiveImage === "function";
                            const imageWidget = targetNode.widgets?.find(w => w.name === "image");
                            if (!puedeRecibir && !imageWidget) {
                                alert(`[Academia SD] ❌ The node "${targetTitle}" cannot take an image.
Use a Load Image node, or an Academia SD Multi Image Reference.`);
                                return;
                            }

                            const originalText = this.sendButtonWidget.name;
                            this.sendButtonWidget.name = "⏳ COPYING...";
                            app.graph.setDirtyCanvas(true, true);

                            try {
                                // 3. Pedirle a Python que copie la imagen de Output a Input
                                const response = await fetch("/academia/send_to_edit", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                        filename: this.lastSavedFilename,
                                        subfolder: this.lastSavedSubfolder
                                    })
                                });
                                
                                const result = await response.json();

                                if (result.status === "success") {
                                    
                                    // 4a. El nodo se encarga solo: repinta y guarda su
                                    // estado por su cuenta, asi que aqui se acaba.
                                    if (puedeRecibir) {
                                        targetNode.asdReceiveImage(result.target_path);
                                        targetNode.setDirtyCanvas(true, true);
                                        app.graph.setDirtyCanvas(true, true);
                                        this.sendButtonWidget.name = "✅ IMAGE SENT!";
                                        setTimeout(() => {
                                            this.sendButtonWidget.name = originalText;
                                            app.graph.setDirtyCanvas(true, true);
                                        }, 2000);
                                        return;
                                    }

                                    // 4b. Load Image: se le cambia el texto del widget
                                    imageWidget.value = result.target_path;
                                    
                                    // 5. ¡TRUCO DEFINITIVO PARA FORZAR LA PREVISUALIZACIÓN!
                                    // Le decimos al nodo que acaba de subir una imagen llamada X a la carpeta input
                                    const img = new Image();
                                    
                                    // Construimos la URL que ComfyUI usa para mostrar imágenes del input
                                    const src = api.apiURL(`/view?filename=${encodeURIComponent(result.target_path)}&type=input&t=${Date.now()}`);
                                    
                                    img.onload = () => {
                                        // Inyectamos la imagen en la memoria caché visual del nodo destino
                                        targetNode.imgs = [img];
                                        
                                        // Forzamos al canvas a redibujar el nodo con la nueva imagen
                                        targetNode.setDirtyCanvas(true, true);
                                        app.graph.setDirtyCanvas(true, true);
                                    };
                                    
                                    // Disparamos la carga de la imagen en el navegador
                                    img.src = src;
                                    
                                    // Ejecutamos el callback interno del widget por si tiene otras lógicas atadas
                                    if (imageWidget.callback) {
                                        imageWidget.callback(imageWidget.value);
                                    }

                                    this.sendButtonWidget.name = "✅ IMAGE SENT!";
                                } else {
                                    alert(`[Academia SD] ❌ Error copying file: ${result.message}`);
                                    this.sendButtonWidget.name = "❌ ERROR";
                                }
                            } catch (e) {
                                alert(`[Academia SD] ❌ Network error: ${e.message}`);
                                this.sendButtonWidget.name = "❌ ERROR";
                            }
                            
                            setTimeout(() => {
                                this.sendButtonWidget.name = originalText;
                                app.graph.setDirtyCanvas(true, true);
                            }, 2000);
                        });
                    }
                }
            }
        }
    }
});
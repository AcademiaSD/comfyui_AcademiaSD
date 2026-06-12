import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.GeminiVision",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_GeminiVision") {
            
            // --- ESCUDO ANTI-FUGAS (SECURITY SHIELD) ---
            // Si el usuario guarda el workflow (Ctrl+S) y no le había dado a guardar el Token,
            // vaciamos la caja para que su API Key no viaje en el archivo .json ni en la imagen PNG.
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                const apiWidget = this.widgets.find(w => w.name === "api_key");
                if (apiWidget && apiWidget.value !== "****" && apiWidget.value !== "") {
                    // Borramos la clave real del archivo guardado
                    const idx = this.widgets.indexOf(apiWidget);
                    if (o.widgets_values && o.widgets_values[idx]) {
                        o.widgets_values[idx] = "";
                    }
                }
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const apiKeyWidget = this.widgets.find(w => w.name === "api_key");
                const modelWidget = this.widgets.find(w => w.name === "model");

                // 1. Magia visual: ocultar caracteres mientras escribes
                if (apiKeyWidget && apiKeyWidget.inputEl) {
                    apiKeyWidget.inputEl.type = "password";
                }

                // 2. Botón para guardar el Token globalmente
                const saveBtn = this.addWidget("button", "💾 Save API Key", "button", async () => {
                    const token = apiKeyWidget.value;
                    if (!token || token === "****") {
                        alert("[AcademiaSD] ⚠️ Please paste a valid API Key first.");
                        return;
                    }

                    try {
                        const res = await fetch("/academia/gemini_token", {
                            method: "POST",
                            headers: {"Content-Type": "application/json"},
                            body: JSON.stringify({token: token})
                        });
                        const data = await res.json();
                        if (data.status === "success") {
                            saveBtn.name = "✅ Saved successfully!";
                            apiKeyWidget.value = "****"; // Ocultamos el valor real del nodo
                            app.graph.setDirtyCanvas(true, false);
                            setTimeout(() => { 
                                saveBtn.name = "💾 Save API Key"; 
                                app.graph.setDirtyCanvas(true, true); 
                            }, 2000);
                        }
                    } catch(e) {
                        alert("[AcademiaSD] ❌ Error saving token.");
                    }
                });

                // 3. Botón para buscar modelos en Google
                const fetchBtn = this.addWidget("button", "🔄 Fetch API Models", "button", async () => {
                    const originalName = fetchBtn.name;
                    fetchBtn.name = "⏳ Fetching...";
                    app.graph.setDirtyCanvas(true, true);

                    try {
                        const response = await fetch("/academia/gemini_models", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ api_key: apiKeyWidget.value })
                        });

                        const data = await response.json();

                        if (data.error) {
                            alert(`[AcademiaSD] ❌ API Error: ${data.error}`);
                        } else if (data.models && data.models.length > 0) {
                            modelWidget.options.values = data.models;
                            if (!data.models.includes(modelWidget.value)) {
                                modelWidget.value = data.models[0];
                            }
                            alert(`[AcademiaSD] ✅ Successfully fetched ${data.models.length} models from Google GenAI!`);
                        } else {
                            alert("[AcademiaSD] ⚠️ No models returned by the API.");
                        }
                    } catch (e) {
                        alert(`[AcademiaSD] ❌ Network Error: ${e.message}`);
                    }

                    fetchBtn.name = originalName;
                    app.graph.setDirtyCanvas(true, true);
                });

                // 4. Inicialización: Comprobar si ya existe un token global guardado
                setTimeout(async () => {
                    try {
                        const res = await fetch("/academia/gemini_token");
                        const data = await res.json();
                        if (data.token && data.token !== "") {
                            // Si existe globalmente, mostramos los asteriscos de seguridad
                            apiKeyWidget.value = "****";
                            app.graph.setDirtyCanvas(true, false);
                        }
                    } catch(e) {}
                }, 200);
            };
        }
    }
});
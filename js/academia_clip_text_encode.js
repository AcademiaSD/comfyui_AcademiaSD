import { app } from "../../scripts/app.js";

// Función de escape HTML para evitar que etiquetas como <video 1> o <image 1> rompan el DOM
function escapeHTML(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Función auxiliar para ocultar el widget nativo de forma limpia y definitiva
function hideNativeTextWidget(node) {
    if (!node.widgets) return;
    const textWidget = node.widgets.find(w => w.name === "text");
    if (textWidget) {
        textWidget.type = "hidden"; // Tipo oficial de LiteGraph para ocultar widgets
        textWidget.computeSize = () => [0, -4];
        textWidget.draw = () => {};
        if (textWidget.inputEl) {
            textWidget.inputEl.style.display = "none";
            textWidget.inputEl.style.visibility = "hidden";
        }
    }
}

function registerPromptNode(nodeName, defaultFileName) {
    app.registerExtension({
        name: `AcademiaSD.Prompt.${nodeName}`,
        async beforeRegisterNodeDef(nodeType, nodeData, app) {
            if (nodeData.name === nodeName) {
                
                const onSerialize = nodeType.prototype.onSerialize;
                nodeType.prototype.onSerialize = function(o) {
                    if (onSerialize) onSerialize.apply(this, arguments);
                    o.asd_expanded = this.expandedState;
                    o.asd_current_list = this.currentList;
                    o.asd_collapsed_height = this.collapsedHeight;
                    o.asd_expanded_height = this.expandedHeight;
                    o.asd_tray_height = this.trayHeight;
                };

                const onConfigure = nodeType.prototype.onConfigure;
                nodeType.prototype.onConfigure = function(o) {
                    if (onConfigure) onConfigure.apply(this, arguments);
                    if (o.asd_expanded !== undefined) this.expandedState = o.asd_expanded;
                    if (o.asd_current_list !== undefined) this.currentList = o.asd_current_list;
                    if (o.asd_collapsed_height !== undefined) this.collapsedHeight = Math.max(140, o.asd_collapsed_height);
                    if (o.asd_expanded_height !== undefined) this.expandedHeight = Math.max(280, o.asd_expanded_height);
                    if (o.asd_tray_height !== undefined) this.trayHeight = o.asd_tray_height;
                    
                    hideNativeTextWidget(this);

                    if (this.updatePanelState) {
                        this.updatePanelState();
                    }
                };

                const onNodeCreated = nodeType.prototype.onNodeCreated;
                nodeType.prototype.onNodeCreated = function () {
                    if (onNodeCreated) onNodeCreated.apply(this, arguments);

                    const MIN_WIDTH = 420;
                    this.size = [420, 140]; 
                    const _this = this;

                    this.initialized = false;

                    this.expandedState = this.expandedState !== undefined ? this.expandedState : false;
                    this.currentList = this.currentList || defaultFileName;
                    
                    this.collapsedHeight = this.collapsedHeight || 140;
                    this.expandedHeight = this.expandedHeight || 280;
                    this.trayHeight = this.trayHeight || 80;
                    
                    this.activeTab = "recents";
                    this.promptListData = { favorites: [], recents: [] };

                    const ensureDataStructure = () => {
                        this.promptListData = this.promptListData || {};
                        if (!Array.isArray(this.promptListData.favorites)) {
                            this.promptListData.favorites = [];
                        }
                        if (!Array.isArray(this.promptListData.recents)) {
                            this.promptListData.recents = [];
                        }
                    };

                    hideNativeTextWidget(this);

                    const container = document.createElement("div");
                    container.style.cssText = `
                        padding: 4px; background: #222; border-radius: 4px;
                        font-family: sans-serif; font-size: 10px; display: flex;
                        flex-direction: column; gap: 4px; width: 100%; height: 100%;
                        box-sizing: border-box; color: #fff; overflow: hidden;
                    `;

                    container.innerHTML = `
                        <style>
                            .asd-p-textarea {
                                width: 100%; flex: 1; min-height: 50px; resize: none; background: #111; color: #fff;
                                border: 1px solid #444; border-radius: 3px; padding: 5px;
                                font-family: monospace; font-size: 11px; outline: none; box-sizing: border-box;
                            }
                            .asd-p-btn {
                                cursor: pointer; padding: 2px 4px; color: #ddd;
                                border: 1px solid #444; border-radius: 2px;
                                font-size: 9px; background: #2a2a2a; font-weight: bold;
                                transition: background 0.1s, border-color 0.1s;
                            }
                            .asd-p-btn:hover { background: #3a3a3a; border-color: #666; }
                            .asd-p-input {
                                padding: 2px 4px; background: #111; color: #fff;
                                border: 1px solid #444; border-radius: 2px; font-size: 10px;
                            }
                            /* ESTILO DE TARJETA RIGUROSO */
                            .asd-p-card {
                                display: flex; justify-content: space-between; align-items: center;
                                padding: 2px 5px; background: #1a1a1a; border-radius: 2px;
                                border-left: 3px solid #4a6ee0; font-size: 10px; margin: 1px 0;
                                height: 22px; min-height: 22px; max-height: 22px; box-sizing: border-box; flex-shrink: 0; overflow: hidden;
                            }
                            .asd-p-card-text {
                                font-family: monospace; color: #ccc; white-space: nowrap;
                                overflow: hidden; text-overflow: ellipsis; flex: 1;
                                line-height: 18px; margin-right: 4px; pointer-events: none;
                            }
                            /* BARRA SEPARADORA ARRASTRABLE */
                            .asd-p-splitter {
                                height: 5px; background: #333; cursor: row-resize; border-radius: 2px;
                                margin: 2px 0; flex-shrink: 0; transition: background 0.15s;
                                display: flex; align-items: center; justify-content: center;
                            }
                            .asd-p-splitter:hover, .asd-p-splitter.dragging {
                                background: #4a6ee0;
                            }
                            .asd-p-splitter::after {
                                content: ""; width: 20px; height: 1px; background: #666;
                            }
                        </style>
                        <textarea class="asd-p-textarea" placeholder="Enter your prompt here..."></textarea>
                        <div style="display: flex; justify-content: space-between; align-items: center; gap: 4px; flex-shrink: 0;">
                            <button class="asd-p-btn asd-toggle-panel" style="flex: 1.2;">▼ Expand Panel</button>
                            <button class="asd-p-btn asd-add-favorite" style="flex: 0.8; background: #5a2222; border-color: #7b2a2a;">❤️ Favorite</button>
                        </div>
                        <div class="asd-extended-area" style="display: none; flex-direction: column; gap: 4px; border-top: 1px solid #444; padding-top: 4px; margin-top: 2px; flex-shrink: 0;">
                            <div style="display: flex; gap: 4px; align-items: center;">
                                <span style="color: #aaa; font-size: 9px;">Preset:</span>
                                <select class="asd-p-input asd-list-select" style="flex: 1; padding: 1px;"></select>
                                <button class="asd-p-btn asd-btn-load">📂 Load</button>
                                <button class="asd-p-btn asd-btn-save" style="background: #1a5c2b; border-color: #2d9444;">💾 Save</button>
                                <button class="asd-p-btn asd-btn-saveas">📝 Save As</button>
                                <button class="asd-p-btn asd-btn-delete-list" style="background: #5a2222;">❌ Del</button>
                            </div>
                            <div style="display: flex; gap: 2px; border-bottom: 1px solid #333; padding-bottom: 2px;">
                                <button class="asd-p-btn asd-tab-recents" style="flex: 1; border-bottom: none; border-radius: 2px 2px 0 0;">⏪ Recents</button>
                                <button class="asd-p-btn asd-tab-favorites" style="flex: 1; border-bottom: none; border-radius: 2px 2px 0 0;">⭐ Favorites</button>
                            </div>
                            <div class="asd-p-splitter" title="Drag to resize tray height"></div>
                            <div class="asd-prompts-tray" style="height: 80px; max-height: 80px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; background: #111; padding: 2px; border-radius: 2px; border: 1px solid #333;">
                                <!-- Prompts dinámicos -->
                            </div>
                            <div style="display: flex; gap: 2px;">
                                <button class="asd-p-btn asd-btn-import" style="flex: 1;">📥 Import JSON</button>
                                <button class="asd-p-btn asd-btn-export" style="flex: 1;">📤 Export JSON</button>
                                <input type="file" class="asd-file-import" accept=".json" style="display: none;">
                            </div>
                        </div>
                    `;

                    const textarea = container.querySelector(".asd-p-textarea");
                    const toggleBtn = container.querySelector(".asd-toggle-panel");
                    const addFavBtn = container.querySelector(".asd-add-favorite");
                    const extendedArea = container.querySelector(".asd-extended-area");
                    const listSelect = container.querySelector(".asd-list-select");
                    const tabRecents = container.querySelector(".asd-tab-recents");
                    const tabFavorites = container.querySelector(".asd-tab-favorites");
                    const promptsTray = container.querySelector(".asd-prompts-tray");
                    const splitter = container.querySelector(".asd-p-splitter");
                    const fileImport = container.querySelector(".asd-file-import");

                    textarea.addEventListener("keydown", (e) => e.stopPropagation());
                    textarea.addEventListener("keyup", (e) => e.stopPropagation());

                    if (splitter) {
                        let startY = 0;
                        let startH = 0;

                        const onMouseMove = (e) => {
                            const dy = startY - e.clientY;
                            let newH = Math.max(30, Math.min(250, startH + dy));
                            _this.trayHeight = newH;
                            promptsTray.style.height = newH + "px";
                            promptsTray.style.maxHeight = newH + "px";
                        };

                        const onMouseUp = () => {
                            splitter.classList.remove("dragging");
                            window.removeEventListener("mousemove", onMouseMove);
                            window.removeEventListener("mouseup", onMouseUp);
                        };

                        splitter.addEventListener("mousedown", (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            startY = e.clientY;
                            startH = promptsTray.offsetHeight;
                            splitter.classList.add("dragging");
                            window.addEventListener("mousemove", onMouseMove);
                            window.addEventListener("mouseup", onMouseUp);
                        });
                    }

                    // CORRECCIÓN QUIRÚRGICA: Ajustar solo el container del nodo
                    // Sin alterar nunca container.parentElement (para no romper la capa de clics global de ComfyUI)
                    const adjustContainerHeight = () => {
                        if (!container) return;
                        const targetH = Math.max(90, _this.size[1] - 40);
                        container.style.height = targetH + "px";
                        container.style.maxHeight = targetH + "px";
                    };

                    this.computeSize = function(out) {
                        let minH = _this.expandedState ? 280 : 140; 
                        return [MIN_WIDTH, minH];
                    };

                    const originalOnResize = this.onResize;
                    this.onResize = function(size) {
                        if (originalOnResize) originalOnResize.apply(this, arguments);
                        if (size[0] < MIN_WIDTH) size[0] = MIN_WIDTH;
                        
                        const minH = _this.expandedState ? 280 : 140;
                        if (size[1] < minH) size[1] = minH;

                        if (_this.initialized) {
                            if (_this.expandedState) {
                                _this.expandedHeight = size[1];
                            } else {
                                _this.collapsedHeight = size[1];
                            }
                        }
                        adjustContainerHeight();
                        app.graph?.setDirtyCanvas(true, true);
                    };

                    const originalDrawForeground = this.onDrawForeground;
                    this.onDrawForeground = function(ctx) {
                        hideNativeTextWidget(_this);
                        adjustContainerHeight();
                        if (originalDrawForeground) originalDrawForeground.apply(this, arguments);
                    };

                    textarea.addEventListener("input", (e) => {
                        const liveTextWidget = _this.widgets.find(w => w.name === "text");
                        if (liveTextWidget) liveTextWidget.value = e.target.value;
                    });

                    toggleBtn.addEventListener("click", () => {
                        this.expandedState = !this.expandedState;
                        updatePanelState();
                    });

                    const updatePanelState = () => {
                        if (_this.expandedState) {
                            extendedArea.style.display = "flex";
                            toggleBtn.innerText = "▲ Collapse Panel";
                            const targetH = Math.max(280, _this.expandedHeight || 280);
                            _this.setSize([_this.size[0], targetH]);
                        } else {
                            extendedArea.style.display = "none";
                            toggleBtn.innerText = "▼ Expand Panel";
                            const targetH = Math.max(140, _this.collapsedHeight || 140);
                            _this.setSize([_this.size[0], targetH]);
                        }
                        
                        if (promptsTray) {
                            const trayH = _this.trayHeight || 80;
                            promptsTray.style.height = trayH + "px";
                            promptsTray.style.maxHeight = trayH + "px";
                        }

                        adjustContainerHeight();
                        app.graph?.setDirtyCanvas(true, true);
                    };

                    this.updatePanelState = updatePanelState;

                    // --- PROCESADO DE SERVIDOR ---
                    const refreshLists = async () => {
                        try {
                            const res = await fetch("/academia/prompts/list");
                            const data = await res.json();
                            if (data.status === "success") {
                                listSelect.innerHTML = "";
                                data.files.forEach(f => {
                                    const opt = document.createElement("option");
                                    opt.value = f; opt.innerText = f;
                                    listSelect.appendChild(opt);
                                });
                                listSelect.value = data.files.includes(this.currentList) ? this.currentList : defaultFileName;
                            }
                        } catch (e) {}
                    };

                    const loadListFromServer = async (name) => {
                        try {
                            const res = await fetch(`/academia/prompts/load?name=${name}`);
                            const rData = await res.json();
                            if (rData.status === "success") {
                                this.promptListData = rData.data || {};
                                ensureDataStructure();
                                this.currentList = name;
                                listSelect.value = name;
                                renderTray();
                            }
                        } catch (e) {}
                    };

                    const saveListToServer = async (name) => {
                        try {
                            ensureDataStructure();
                            await fetch("/academia/prompts/save", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ name: name, data: this.promptListData })
                            });
                            this.currentList = name;
                            await refreshLists();
                            renderTray();
                        } catch (e) {}
                    };

                    // --- BOTÓN FAVORITOS ---
                    addFavBtn.addEventListener("click", () => {
                        ensureDataStructure();
                        const activePrompt = textarea.value.trim();
                        
                        if (!activePrompt) {
                            addFavBtn.innerText = "⚠️ Write prompt!";
                            setTimeout(() => addFavBtn.innerText = "❤️ Favorite", 1200);
                            return;
                        }

                        if (this.promptListData.favorites.includes(activePrompt)) {
                            addFavBtn.innerText = "⭐ Already Fav!";
                            setTimeout(() => addFavBtn.innerText = "❤️ Favorite", 1200);
                            return;
                        }

                        this.promptListData.favorites.unshift(activePrompt);
                        this.activeTab = "favorites";
                        saveListToServer(this.currentList);
                        
                        addFavBtn.innerText = "✅ Saved!";
                        setTimeout(() => addFavBtn.innerText = "❤️ Favorite", 1200);
                    });

                    // --- RENDERING DE LA BANDEJA Y TARJETAS (ESCAPADO HTML SEGURO) ---
                    const renderTray = () => {
                        promptsTray.innerHTML = "";
                        ensureDataStructure();
                        
                        const activeList = this.activeTab === "recents" ? this.promptListData.recents : this.promptListData.favorites;
                        
                        if (this.activeTab === "recents") {
                            tabRecents.style.background = "#4a6ee0"; tabRecents.style.color = "#fff";
                            tabFavorites.style.background = "#222"; tabFavorites.style.color = "#ccc";
                        } else {
                            tabFavorites.style.background = "#4a6ee0"; tabFavorites.style.color = "#fff";
                            tabRecents.style.background = "#222"; tabRecents.style.color = "#ccc";
                        }

                        if (!activeList || activeList.length === 0) {
                            promptsTray.innerHTML = `<div style="text-align:center; padding:10px; color:#666; font-size:9px;">No prompts found</div>`;
                            return;
                        }

                        activeList.forEach((promptText, idx) => {
                            const card = document.createElement("div");
                            card.className = "asd-p-card";
                            
                            // 1. Limpieza de saltos de línea para la vista previa de 1 línea
                            const cleanDisplay = promptText.replace(/\s+/g, ' ').trim();
                            // 2. Escape HTML para que etiquetas como <video 1> no rompan la tarjeta
                            const escapedDisplay = escapeHTML(cleanDisplay);
                            const escapedTitle = escapeHTML(promptText);

                            card.innerHTML = `
                                <div class="asd-p-card-text" title="${escapedTitle}">${escapedDisplay}</div>
                                <div style="display:flex; gap:2px; flex-shrink:0; align-items:center;">
                                    <button class="asd-p-btn asd-btn-card-load">📂 Load</button>
                                    ${this.activeTab === "recents" ? '<button class="asd-p-btn asd-btn-card-add-fav">❤️</button>' : ''}
                                    <button class="asd-p-btn asd-btn-card-del" style="background:#5a2222; border-color:#5a2222;">🗑️</button>
                                </div>
                            `;

                            card.querySelector(".asd-btn-card-load").addEventListener("click", () => {
                                textarea.value = promptText;
                                const liveTextWidget = _this.widgets.find(w => w.name === "text");
                                if (liveTextWidget) liveTextWidget.value = promptText;
                                
                                this.expandedState = false;
                                updatePanelState();
                            });

                            if (this.activeTab === "recents") {
                                card.querySelector(".asd-btn-card-add-fav").addEventListener("click", () => {
                                    ensureDataStructure();
                                    if (!this.promptListData.favorites.includes(promptText)) {
                                        this.promptListData.favorites.unshift(promptText);
                                        saveListToServer(this.currentList);
                                    }
                                });
                            }

                            card.querySelector(".asd-btn-card-del").addEventListener("click", () => {
                                activeList.splice(idx, 1);
                                saveListToServer(this.currentList);
                            });

                            promptsTray.appendChild(card);
                        });
                    };

                    tabRecents.addEventListener("click", () => { this.activeTab = "recents"; renderTray(); });
                    tabFavorites.addEventListener("click", () => { this.activeTab = "favorites"; renderTray(); });

                    container.querySelector(".asd-btn-load").addEventListener("click", () => {
                        loadListFromServer(listSelect.value);
                    });

                    container.querySelector(".asd-btn-save").addEventListener("click", () => {
                        saveListToServer(this.currentList);
                    });

                    container.querySelector(".asd-btn-saveas").addEventListener("click", () => {
                        const name = prompt("Enter a NEW name for this list:", this.currentList + "_copy");
                        if (name) saveListToServer(name);
                    });

                    container.querySelector(".asd-btn-delete-list").addEventListener("click", async () => {
                        if (listSelect.value === "default_positive_prompt" || listSelect.value === "default_negative_prompt") {
                            alert("Cannot delete default template lists.");
                            return;
                        }
                        if (confirm(`Are you sure you want to delete the list: ${listSelect.value}?`)) {
                            try {
                                await fetch(`/academia/prompts/delete?name=${listSelect.value}`, { method: "DELETE" });
                                await refreshLists();
                                loadListFromServer(defaultFileName);
                            } catch(e) {}
                        }
                    });

                    container.querySelector(".asd-btn-export").addEventListener("click", () => {
                        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.promptListData, null, 4));
                        const dlNode = document.createElement('a');
                        dlNode.setAttribute("href", dataStr);
                        dlNode.setAttribute("download", `${this.currentList}.json`);
                        document.body.appendChild(dlNode);
                        dlNode.click();
                        dlNode.remove();
                    });

                    container.querySelector(".asd-btn-import").addEventListener("click", () => fileImport.click());
                    fileImport.addEventListener("change", (e) => {
                        const file = e.target.files[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = async (event) => {
                            try {
                                const parsed = JSON.parse(event.target.result);
                                if (parsed.favorites || parsed.recents) {
                                    this.promptListData.favorites = parsed.favorites || [];
                                    this.promptListData.recents = parsed.recents || [];
                                    
                                    const customName = file.name.replace(".json", "");
                                    await saveListToServer(customName);
                                    alert(`Successfully imported: ${customName}`);
                                } else {
                                    alert("Invalid file structure. Must contain 'favorites' or 'recents'.");
                                }
                            } catch (err) { alert("Error parsing JSON file."); }
                        };
                        reader.readAsText(file);
                        fileImport.value = "";
                    });

                    container.addEventListener("mousedown", (e) => e.stopPropagation());
					const domWidget = this.addDOMWidget("UI", "HTML", container);

					// El DOM widget no debe participar en el layout del nodo.
					domWidget.computeSize = function() {
						return [0, 0];
					};

					// IMPORTANTE:
					// El elemento DOM generado por ComfyUI puede conservar un área
					// física mayor que el container y bloquear los nodos que están debajo.
					// Lo hacemos completamente transparente para eventos fuera del
					// contenido real del panel.
					const domElement =
						domWidget.element ||
						domWidget.inputEl ||
						domWidget.domElement;

					if (domElement) {

						domElement.style.position = "absolute";
						domElement.style.left = "0";
						domElement.style.top = "0";

						// No permitir que el elemento DOM determine el tamaño.
						domElement.style.width = "100%";
						domElement.style.height = "100%";

						domElement.style.margin = "0";
						domElement.style.padding = "0";
						domElement.style.boxSizing = "border-box";

						domElement.style.pointerEvents = "none";

						// El contenido real sí puede recibir clicks.
						container.style.pointerEvents = "auto";
					}

                    hideNativeTextWidget(this);

                    const textWidget = this.widgets.find(w => w.name === "text");
                    if (textWidget) {
                        textWidget.serializeValue = () => {
                            const currentVal = textarea.value.trim();
                            if (currentVal) {
                                ensureDataStructure();
                                const existingIndex = this.promptListData.recents.indexOf(currentVal);
                                if (existingIndex !== -1) {
                                    this.promptListData.recents.splice(existingIndex, 1);
                                }
                                this.promptListData.recents.unshift(currentVal);
                                if (this.promptListData.recents.length > 10) {
                                    this.promptListData.recents.pop();
                                }
                                saveListToServer(this.currentList);
                            }
                            return textarea.value;
                        };
                    }

                    updatePanelState();

                    refreshLists().then(() => {
                        loadListFromServer(this.currentList).then(() => {
                            const liveTextWidget = _this.widgets.find(w => w.name === "text");
                            if (liveTextWidget && liveTextWidget.value) {
                                textarea.value = liveTextWidget.value;
                            }
                            updatePanelState();

                            setTimeout(() => {
                                _this.initialized = true;
                            }, 200);
                        }).catch(e => console.error("Error loading list:", e));
                    }).catch(e => console.error("Error refreshing lists:", e));
                };
            }
        }
    });
}

registerPromptNode("AcademiaSD_PositivePrompt", "default_positive_prompt");
registerPromptNode("AcademiaSD_NegativePrompt", "default_negative_prompt");
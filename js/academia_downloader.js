import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.Downloader",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_Downloader") {
            
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                
                o.academia_models = [];
                if (this.rowsContainer) {
                    for(let row of this.rowsContainer.children) {
                        const url = row.querySelector(".url-input").value;
                        
                        // Extraer datos dependiendo de si es desplegable (HF) o div estático (Direct Link)
                        let selected_url = url;
                        let filename = "Direct Link";
                        const selectFile = row.querySelector(".file-select");
                        if (selectFile) {
                            selected_url = selectFile.value;
                            filename = selectFile.options[selectFile.selectedIndex]?.text || "";
                        }
                        
                        const filesize = row.querySelector(".size-label").innerText;
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;
                        
                        if(url.trim() !== "") {
                            o.academia_models.push({ url, selected_url, filename, filesize, folder, subfolder });
                        }
                    }
                }
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                if (o.academia_models) this.restored_models = o.academia_models;
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                // Tamaño un poco más ancho para que la cuadrícula respire
                this.size = [950, 260];
                let folders = [];

                const container = document.createElement("div");
                container.style.cssText = `
                    padding: 10px; color: white; background: #222; 
                    font-family: sans-serif; font-size: 12px; width: 100%; height: 100%;
                    box-sizing: border-box; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
                    border-radius: 5px;
                `;

                // --- TOP BAR ---
                const topBar = document.createElement("div");
                topBar.style.display = "flex"; topBar.style.gap = "8px"; topBar.style.alignItems = "center";
                
                const btnAdd = document.createElement("button");
                btnAdd.innerText = "➕ Add";
                btnAdd.style.cssText = "cursor: pointer; padding: 6px 10px; background: #444; color: white; border: 1px solid #666; border-radius: 4px; font-weight: bold;";
                
                const btnRefresh = document.createElement("button");
                btnRefresh.innerText = "🔄 Refresh";
                btnRefresh.style.cssText = "cursor: pointer; padding: 6px 10px; background: #444; color: white; border: 1px solid #666; border-radius: 4px; font-weight: bold;";
                
                this.civitaiInput = document.createElement("input");
                this.civitaiInput.type = "password";
                this.civitaiInput.placeholder = "Civitai API Key";
                this.civitaiInput.style.cssText = "flex: 1; padding: 6px; border-radius: 3px; border: 1px solid #555; outline: none; background: #111; color: white;";

                this.hfInput = document.createElement("input");
                this.hfInput.type = "password";
                this.hfInput.placeholder = "HuggingFace Token";
                this.hfInput.style.cssText = "flex: 1; padding: 6px; border-radius: 3px; border: 1px solid #555; outline: none; background: #111; color: white;";
                
                const btnSaveTokens = document.createElement("button");
                btnSaveTokens.innerText = "💾 Save Tokens";
                btnSaveTokens.style.cssText = "cursor: pointer; padding: 6px 12px; background: #2d5a27; color: white; border: 1px solid #3c7a34; border-radius: 4px; font-weight: bold;";
                
                topBar.appendChild(btnAdd);
                topBar.appendChild(btnRefresh);
                topBar.appendChild(this.civitaiInput);
                topBar.appendChild(this.hfInput);
                topBar.appendChild(btnSaveTokens);
                container.appendChild(topBar);

                // --- ROWS CONTAINER ---
                this.rowsContainer = document.createElement("div");
                this.rowsContainer.style.display = "flex";
                this.rowsContainer.style.flexDirection = "column";
                this.rowsContainer.style.gap = "6px"; // Menos espacio entre filas para un look más compacto
                container.appendChild(this.rowsContainer);

                // --- BOTTOM BUTTON ---
                const btnDownloadAll = document.createElement("button");
                btnDownloadAll.innerText = "⬇️ Download All";
                btnDownloadAll.style.cssText = "margin-top: auto; cursor: pointer; padding: 8px; background: #1a5c2b; color: white; border: 1px solid #2d9444; border-radius: 4px; font-weight: bold;";
                container.appendChild(btnDownloadAll);

                // Load global tokens
                const loadGlobalTokens = async () => {
                    try {
                        const res = await fetch("/academia/tokens");
                        const data = await res.json();
                        if (data.civitai) this.civitaiInput.value = data.civitai;
                        if (data.huggingface) this.hfInput.value = data.huggingface;
                    } catch(e) {}
                };

                btnSaveTokens.addEventListener("click", async () => {
                    try {
                        btnSaveTokens.innerText = "⌛...";
                        await fetch("/academia/tokens", {
                            method: "POST", headers: {"Content-Type": "application/json"},
                            body: JSON.stringify({ civitai: this.civitaiInput.value, huggingface: this.hfInput.value })
                        });
                        btnSaveTokens.innerText = "✅ Saved!";
                        setTimeout(() => btnSaveTokens.innerText = "💾 Save Tokens", 2000);
                    } catch(e) {
                        btnSaveTokens.innerText = "❌ Error";
                    }
                });

                async function fetchFolders() {
                    try {
                        const res = await fetch("/academia/folders");
                        folders = await res.json();
                    } catch (e) {}
                }

                // --- CREACIÓN DE FILA ALINEADA CON CSS GRID ---
                const addRow = (data = {}, isRestoring = false) => {
                    const row = document.createElement("div");
                    
                    // Magia de la cuadrícula: 8 columnas con proporciones exactas
                    // Col 1: URL | Col 2: Selector Archivo | Col 3: Tamaño | Col 4: Tipo | Col 5: Subcarpeta | Col 6: Botón | Col 7: LED | Col 8: Eliminar
                    row.style.display = "grid";
                    row.style.gridTemplateColumns = "3fr 2.5fr 70px 1.2fr 1fr 90px 20px 20px";
                    row.style.gap = "6px";
                    row.style.alignItems = "center";
                    row.style.background = "#333";
                    row.style.padding = "5px 8px";
                    row.style.borderRadius = "4px";

                    // 1. URL Principal
                    const inputUrl = document.createElement("input");
                    inputUrl.className = "url-input";
                    inputUrl.type = "text";
                    inputUrl.value = data.url || "";
                    inputUrl.placeholder = "URL (Civitai, HF...)";
                    inputUrl.style.cssText = "width: 100%; padding: 4px 6px; box-sizing: border-box; border-radius: 3px; border: none; outline: none; background: #111; color: white;";

                    // Contenedor para la columna 2 (Desplegable o Texto Fijo)
                    const fileCell = document.createElement("div");
                    fileCell.style.width = "100%";
                    
                    // Col 2A: Desplegable HF (Oculto por defecto)
                    const selectFile = document.createElement("select");
                    selectFile.className = "file-select";
                    selectFile.style.cssText = "width: 100%; padding: 4px; box-sizing: border-box; border-radius: 3px; border: none; background: #2a2a2a; color: white; display: none;";
                    
                    // Col 2B: Etiqueta "Direct Link" (Visible por defecto)
                    const directLabel = document.createElement("div");
                    directLabel.innerText = "Direct Link";
                    directLabel.style.cssText = "width: 100%; padding: 4px 6px; box-sizing: border-box; border-radius: 3px; background: #222; color: #888; cursor: not-allowed; text-align: center;";

                    fileCell.appendChild(selectFile);
                    fileCell.appendChild(directLabel);

                    // Lógica de restauración visual de la Col 2
                    if (data.selected_url && data.filename && data.filename !== "Direct Link") {
                        const opt = document.createElement("option");
                        opt.value = data.selected_url; opt.innerText = data.filename;
                        selectFile.appendChild(opt);
                        selectFile.style.display = "block";
                        directLabel.style.display = "none";
                    }

                    // 3. Tamaño
                    const labelSize = document.createElement("div");
                    labelSize.className = "size-label";
                    labelSize.innerText = data.filesize || "-- MB";
                    labelSize.style.cssText = "width: 100%; text-align: center; color: #aaa; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";

                    // 4. Tipo de Carpeta
                    const selectFolder = document.createElement("select");
                    selectFolder.className = "folder-select";
                    selectFolder.style.cssText = "width: 100%; padding: 4px; box-sizing: border-box; border-radius: 3px; border: none; background: #111; color: white;";
                    folders.forEach(f => {
                        const opt = document.createElement("option");
                        opt.value = f; opt.innerText = f;
                        selectFolder.appendChild(opt);
                    });
                    if (data.folder && folders.includes(data.folder)) selectFolder.value = data.folder;
                    else if (folders.includes("loras")) selectFolder.value = "loras";

                    // 5. Subcarpeta
                    const inputSubfolder = document.createElement("input");
                    inputSubfolder.className = "subfolder-input";
                    inputSubfolder.type = "text";
                    inputSubfolder.value = data.subfolder || "";
                    inputSubfolder.placeholder = "Subfolder";
                    inputSubfolder.style.cssText = "width: 100%; padding: 4px 6px; box-sizing: border-box; border-radius: 3px; border: none; outline: none; background: #111; color: white;";

                    // 6. Botón Descargar
                    const btnDownload = document.createElement("button");
                    btnDownload.innerText = "Download";
                    btnDownload.style.cssText = "width: 100%; cursor: pointer; padding: 4px 0; background: #225588; color: white; border: none; border-radius: 3px; text-align: center; font-weight: bold;";

                    // 7. LED
                    const ledCell = document.createElement("div");
                    ledCell.style.cssText = "display: flex; justify-content: center;";
                    const led = document.createElement("div");
                    led.style.cssText = "width: 12px; height: 12px; border-radius: 50%; background-color: red; box-shadow: 0 0 6px red;";
                    led.title = "Not downloaded yet";
                    ledCell.appendChild(led);

                    // 8. Botón Eliminar
                    const btnDelete = document.createElement("button");
                    btnDelete.innerText = "❌";
                    btnDelete.style.cssText = "width: 100%; background: transparent; border: none; cursor: pointer; padding: 0; font-size: 14px;";
                    
                    // --- EVENTOS Y LÓGICA ---
                    const handleUrlFetch = async (isRestoringCall = false) => {
                        const url = inputUrl.value;
                        if(!url || !url.startsWith("http")) return;
                        
                        if (!isRestoringCall) labelSize.innerText = "⏳...";
                        
                        try {
                            const res = await fetch("/academia/parse_url", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ url, hf_token: this.hfInput.value })
                            });
                            const parsed = await res.json();
                            const currentSelection = selectFile.value;
                            
                            if(parsed.type === "repo") {
                                selectFile.innerHTML = "";
                                parsed.files.forEach(f => {
                                    const opt = document.createElement("option");
                                    opt.value = f.url;
                                    opt.innerText = f.name;
                                    opt.dataset.size = f.size; 
                                    selectFile.appendChild(opt);
                                });
                                selectFile.style.display = "block";
                                directLabel.style.display = "none"; // Ocultar bloque gris
                                
                                if (Array.from(selectFile.options).some(opt => opt.value === currentSelection)) {
                                    selectFile.value = currentSelection;
                                }
                                
                                if (!isRestoringCall || labelSize.innerText === "-- MB" || labelSize.innerText === "Unknown") {
                                    const firstOptSize = selectFile.options[selectFile.selectedIndex]?.dataset.size;
                                    if (firstOptSize) labelSize.innerText = firstOptSize;
                                }
                            } else {
                                // Es link directo: Mostrar bloque gris, ocultar select
                                selectFile.innerHTML = "";
                                selectFile.style.display = "none";
                                directLabel.style.display = "block";
                            }
                            triggerCheck();
                        } catch(e) { 
                            if (!isRestoringCall) labelSize.innerText = "Error"; 
                        }
                    };

                    const getSelectedUrl = () => {
                        // Si el select está visible, usar su valor. Si no, usar la URL principal.
                        return selectFile.style.display === "block" ? selectFile.value : inputUrl.value;
                    }

                    const triggerCheck = async () => await checkStatus(getSelectedUrl(), selectFolder.value, inputSubfolder.value, led, btnDownload, labelSize, selectFile);
                    
                    inputUrl.addEventListener("change", () => handleUrlFetch(false));
                    selectFile.addEventListener("change", triggerCheck);
                    selectFolder.addEventListener("change", triggerCheck);
                    inputSubfolder.addEventListener("change", triggerCheck);

                    btnDownload.addEventListener("click", async () => {
                        await downloadFile(getSelectedUrl(), selectFolder.value, inputSubfolder.value, led, btnDownload, labelSize);
                    });

                    btnDelete.addEventListener("click", () => {
                        row.remove();
                        this.size[1] -= 38; // Ajustado por el nuevo gap
                    });

                    row.appendChild(inputUrl);
                    row.appendChild(fileCell);
                    row.appendChild(labelSize);
                    row.appendChild(selectFolder);
                    row.appendChild(inputSubfolder);
                    row.appendChild(btnDownload);
                    row.appendChild(ledCell);
                    row.appendChild(btnDelete);
                    this.rowsContainer.appendChild(row);

                    if (!isRestoring) this.size[1] += 38;
                    
                    if (data.url && data.url.startsWith("http")) {
                        setTimeout(() => handleUrlFetch(isRestoring), 300); 
                    }
                };

                const getPayload = (url, folder, subfolder) => ({
                    url, folder, subfolder, 
                    civitai_token: this.civitaiInput.value,
                    hf_token: this.hfInput.value
                });

                async function checkStatus(url, folder, subfolder, ledElement, btnElement, sizeElement, selectElement) {
                    if(!url || url === "none" || !url.startsWith("http")) return;
                    ledElement.style.backgroundColor = "orange";
                    ledElement.style.boxShadow = "0 0 6px orange";
                    
                    try {
                        const res = await fetch("/academia/check", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(getPayload(url, folder, subfolder))
                        });
                        const data = await res.json();
                        
                        let displayedSize = data.filesize || "Unknown";
                        if (displayedSize === "Unknown" || displayedSize === "Error" || displayedSize === "0 B") {
                            // Intentar sacar de la lista si está visible
                            if (selectElement && selectElement.style.display === "block" && selectElement.options.length > 0) {
                                const optSize = selectElement.options[selectElement.selectedIndex]?.dataset.size;
                                if (optSize && optSize !== "undefined" && optSize !== "Unknown") {
                                    displayedSize = optSize;
                                }
                            }
                        }
                        
                        if (displayedSize !== "Unknown" && displayedSize !== "Error" && displayedSize !== "0 B" && displayedSize !== undefined) {
                            sizeElement.innerText = displayedSize;
                        }

                        if (data.exists) {
                            ledElement.style.backgroundColor = "#00ff00";
                            ledElement.style.boxShadow = "0 0 8px #00ff00";
                            ledElement.title = `Ready`;
                            if(btnElement) { btnElement.innerText = "Completed"; btnElement.disabled = true; btnElement.style.background = "#008800"; }
                        } else if (data.is_downloading) {
                            ledElement.style.backgroundColor = "yellow";
                            ledElement.style.boxShadow = "0 0 6px yellow";
                            ledElement.title = `Downloading...`;
                            if(btnElement) { 
                                const pct = data.progress >= 0 ? `${data.progress}%` : "...";
                                btnElement.innerText = `⏳ ${pct}`; 
                                btnElement.disabled = true; 
                                btnElement.style.background = "#555"; 
                            }
                        } else if (data.message === "auth_required") {
                            ledElement.style.backgroundColor = "#ff00ff";
                            ledElement.style.boxShadow = "0 0 6px #ff00ff";
                            ledElement.title = "API Key required!";
                            if(btnElement) { btnElement.innerText = "Need Token"; btnElement.disabled = false; btnElement.style.background = "#aa00aa"; }
                        } else {
                            ledElement.style.backgroundColor = "red";
                            ledElement.style.boxShadow = "0 0 6px red";
                            ledElement.title = "Not downloaded";
                            if(btnElement) { btnElement.innerText = "Download"; btnElement.disabled = false; btnElement.style.background = "#225588"; }
                        }
                        return data;
                    } catch (e) {
                        ledElement.style.backgroundColor = "red";
                    }
                }

                async function downloadFile(url, folder, subfolder, ledElement, btnElement, sizeElement) {
                    if(!url || url === "none" || !url.startsWith("http")) return;
                    btnElement.innerText = "⏳ 0%";
                    btnElement.disabled = true;
                    btnElement.style.background = "#555";
                    ledElement.style.backgroundColor = "yellow";
                    ledElement.style.boxShadow = "0 0 6px yellow";
                    
                    try {
                        await fetch("/academia/download", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(getPayload(url, folder, subfolder))
                        });
                        
                        const poll = async () => {
                            const data = await checkStatus(url, folder, subfolder, ledElement, btnElement, sizeElement, null);
                            if(data && data.exists && !data.is_downloading) return;
                            setTimeout(poll, 1500); 
                        };
                        setTimeout(poll, 1500);

                    } catch (e) {
                        btnElement.innerText = "Error";
                        btnElement.disabled = false;
                        btnElement.style.background = "#cc0000";
                    }
                }

                btnAdd.addEventListener("click", () => addRow());
                
                btnRefresh.addEventListener("click", async () => {
                    for(let row of this.rowsContainer.children) {
                        const selectFile = row.querySelector(".file-select"); 
                        const urlInput = row.querySelector(".url-input");
                        const realUrl = selectFile.style.display === "block" ? selectFile.value : urlInput.value;
                        
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;
                        const sizeEl = row.querySelector(".size-label");
                        
                        // En CSS Grid, el botón es el 6º elemento (index 5) y el LED el 7º (index 6)
                        const btn = row.children[5]; 
                        const ledCell = row.children[6]; 
                        const led = ledCell.firstChild;
                        
                        await checkStatus(realUrl, folder, subfolder, led, btn, sizeEl, selectFile);
                    }
                });

                btnDownloadAll.addEventListener("click", async () => {
                    for(let row of this.rowsContainer.children) {
                        const selectFile = row.querySelector(".file-select"); 
                        const urlInput = row.querySelector(".url-input");
                        const realUrl = selectFile.style.display === "block" ? selectFile.value : urlInput.value;
                        
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;
                        const sizeEl = row.querySelector(".size-label");
                        
                        const btn = row.children[5]; 
                        const ledCell = row.children[6]; 
                        const led = ledCell.firstChild;
                        
                        if(led.style.backgroundColor === "red" || led.style.backgroundColor === "rgb(255, 0, 0)") {
                            await downloadFile(realUrl, folder, subfolder, led, btn, sizeEl);
                        } else if (led.style.backgroundColor === "rgb(255, 0, 255)") {
                            alert("A token is missing to download secure models.");
                        }
                    }
                });

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);
                
                loadGlobalTokens().then(() => {
                    fetchFolders().then(() => {
                        if (this.restored_models && this.restored_models.length > 0) {
                            this.restored_models.forEach(modelData => addRow(modelData, true));
                        } else {
                            addRow();
                        }
                    });
                });
            };
        }
    }
});
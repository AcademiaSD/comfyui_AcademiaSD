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
                        const enabled = row.querySelector(".model-toggle").checked;
                        const url = row.querySelector(".url-input").value;
                        const selectFile = row.querySelector(".file-select");
                        const inputFilename = row.querySelector(".filename-input");
                        
                        const isHF = selectFile.style.display === "block";
                        const selected_url = isHF ? selectFile.value : url;
                        let filename = isHF ? selectFile.options[selectFile.selectedIndex]?.text : inputFilename.value;
                        if (filename) filename = filename.split('/').pop().split('\\').pop();
                        
                        const filesize = row.querySelector(".size-label").innerText;
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;
                        
                        if(url.trim() !== "") {
                            o.academia_models.push({ enabled, url, selected_url, filename, filesize, folder, subfolder });
                        }
                    }
                }
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                if (o.academia_models) {
                    this.restored_models = o.academia_models;
                }
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const MIN_WIDTH = 850;
                this.size = [950, 200];
                let folders = [];
                let currentPreset = "default";
                const _this = this;

                const container = document.createElement("div");
                container.style.cssText = `
                    padding: 10px; color: white; background: #222; 
                    font-family: sans-serif; font-size: 13px; width: 100%; height: 100%;
                    box-sizing: border-box; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
                    border-radius: 5px;
                `;
                
                container.innerHTML = `
                    <style>
                        .asd-switch { position: relative; display: inline-block; width: 30px; height: 16px; flex-shrink: 0;}
                        .asd-switch input { opacity: 0; width: 0; height: 0; }
                        .asd-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #555; transition: .2s; border-radius: 16px; }
                        .asd-slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 2px; bottom: 2px; background-color: #aaa; transition: .2s; border-radius: 50%; }
                        .asd-switch input:checked + .asd-slider { background-color: #4a6ee0; }
                        .asd-switch input:checked + .asd-slider:before { transform: translateX(14px); background-color: white; }
                        
                        .asd-dl-row { display: flex; gap: 8px; align-items: center; background: #333; padding: 5px; border-radius: 4px; transition: opacity 0.2s; border: 2px solid transparent;}
                        .asd-dl-row.disabled { opacity: 0.5; }
                        .asd-dl-row.drag-over-top { border-top: 4px solid #00ff00; }
                        .asd-dl-row.drag-over-bottom { border-bottom: 4px solid #00ff00; }
                        
                        .asd-drag-handle { cursor: grab; color: #888; font-size: 16px; user-select: none; padding: 0 4px; display: flex; align-items: center;}
                        .asd-drag-handle:active { cursor: grabbing; }
                        .asd-drag-handle:hover { color: #fff; }

                        .asd-btn { cursor: pointer; padding: 5px 8px; color: white; border: 1px solid #555; border-radius: 4px; font-weight: bold; background: #333; transition: 0.2s; }
                        .asd-btn:hover { background: #444; }
                        .asd-input { padding: 4px; border-radius: 3px; border: none; outline: none; background: #111; color: white; }
                    </style>
                    <div style="display: flex; gap: 8px;">
                        <button id="asd-btn-add" class="asd-btn" style="flex: 1;">➕ Add Model</button>
                        <button id="asd-btn-check" class="asd-btn">🔄 Check Status</button>
                        <input id="asd-civ-token" type="password" class="asd-input" style="flex: 1.5;" placeholder="Civitai API Key">
                        <input id="asd-hf-token" type="password" class="asd-input" style="flex: 1.5;" placeholder="HuggingFace Token">
                        <button id="asd-btn-savetokens" class="asd-btn" style="background: #2d5a27;">💾 Save Tokens</button>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center; background: #1a1a1a; padding: 6px; border-radius: 4px;">
                        <select id="asd-preset-sel" style="flex: 1; padding: 4px; background: #222; color: white; border: 1px solid #444; border-radius: 3px;"></select>
                        <button id="asd-btn-load" class="asd-btn">📂 Load</button>
                        <button id="asd-btn-save" class="asd-btn">💾 Save</button>
                        <button id="asd-btn-saveas" class="asd-btn">📝 Save As...</button>
                        <button id="asd-btn-import" class="asd-btn">📥 Import</button>
                        <input type="file" id="asd-file-import" accept=".json" style="display: none;">
                        <button id="asd-btn-export" class="asd-btn">📤 Export</button>
                    </div>
                    <div id="asd-rows-container" style="display: flex; flex-direction: column; gap: 4px;"></div>
                    <button id="asd-btn-dl-all" class="asd-btn" style="margin-top: auto; background: #1a5c2b; border-color: #2d9444; padding: 8px;">⬇️ Download All Enabled</button>
                `;

                this.rowsContainer = container.querySelector("#asd-rows-container");

                this.computeSize = function(out) {
					let baseH = 120; 
					let numRows = this.rowsContainer ? this.rowsContainer.children.length : 0;
					let contentHeight = baseH + (numRows * 42);
					
					// Retornamos únicamente los mínimos absolutos requeridos por el contenido
					const width = MIN_WIDTH;
					const height = contentHeight;
					
					return [width, height];
				};

				const forceResize = () => {
					setTimeout(() => {
						const min = this.computeSize();
						// Mantenemos el tamaño actual (this.size) a menos que el nuevo contenido 
						// requiera más espacio del disponible, en cuyo caso forzamos el crecimiento.
						const w = Math.max(this.size[0], min[0]);
						const h = Math.max(this.size[1], min[1]);
						this.setSize([w, h]);
						app.graph.setDirtyCanvas(true, true);
					}, 10);
				};

				const originalOnResize = this.onResize;
				this.onResize = function(size) {
					if (originalOnResize) originalOnResize.apply(this, arguments);
					
					let numRows = this.rowsContainer ? this.rowsContainer.children.length : 0;
					let contentHeight = 120 + (numRows * 42);
					
					// Evitamos que el usuario encoja el nodo por debajo de los límites del contenido
					if (size[0] < MIN_WIDTH) {
						size[0] = MIN_WIDTH;
					}
					if (size[1] < contentHeight) {
						size[1] = contentHeight;
					}
				};

                const getRowPayload = (row) => {
                    const urlInput = row.querySelector(".url-input").value;
                    const fileSelect = row.querySelector(".file-select");
                    const isHF = fileSelect.style.display === "block";
                    
                    let fname = isHF ? fileSelect.options[fileSelect.selectedIndex]?.text : row.querySelector(".filename-input").value;
                    if (fname) fname = fname.split('/').pop().split('\\').pop();

                    return {
                        url: isHF ? fileSelect.value : urlInput,
                        folder: row.querySelector(".folder-select").value,
                        subfolder: row.querySelector(".subfolder-input").value,
                        filename: fname,
                        civitai_token: container.querySelector("#asd-civ-token").value,
                        hf_token: container.querySelector("#asd-hf-token").value
                    };
                };

                const checkRowStatus = async (row) => {
                    const payload = getRowPayload(row);
                    if(!payload.url || payload.url === "none") return;
                    
                    const led = row.querySelector(".asd-led");
                    const btn = row.querySelector(".asd-dl-btn");
                    const sizeLabel = row.querySelector(".size-label");
                    const fileSelect = row.querySelector(".file-select");
                    const fnameInput = row.querySelector(".filename-input");

                    led.style.backgroundColor = "orange";
                    
                    try {
                        const res = await fetch("/academia/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
                        const data = await res.json();
                        
                        if (data.filename && data.filename !== "Direct Link" && data.filename !== "Pending...") {
                            if (fileSelect.style.display !== "block") {
                                fnameInput.value = data.filename;
                                fnameInput.style.color = "#ddd"; 
                            }
                        }
                        
                        let newSize = data.filesize || "Unknown";
                        if ((newSize === "Unknown" || newSize === "Error" || newSize === "0 B") && fileSelect.style.display === "block") {
                             const opt = fileSelect.options[fileSelect.selectedIndex];
                             if (opt && opt.dataset.size) newSize = opt.dataset.size;
                        }
                        if (newSize !== "Unknown" && newSize !== "Error" && newSize !== "0 B") {
                             sizeLabel.innerText = newSize;
                        }

                        if (data.exists) {
                            led.style.backgroundColor = "#00ff00"; led.title = `Ready: ${data.filename}`;
                            btn.innerText = "Completed"; btn.disabled = true; btn.style.background = "#008800";
                        } else if (data.is_downloading) {
                            led.style.backgroundColor = "yellow"; led.title = `Downloading...`;
                            btn.innerText = `⏳ ${data.progress >= 0 ? data.progress + "%" : "..."}`; 
                            btn.disabled = true; btn.style.background = "#555";
                        } else if (data.message === "auth_required") {
                            led.style.backgroundColor = "#ff00ff"; led.title = "API Key Required";
                            btn.innerText = "Need Token"; btn.disabled = false; btn.style.background = "#aa00aa";
                        } else {
                            led.style.backgroundColor = "red"; led.title = "Not downloaded";
                            btn.innerText = "Download"; btn.disabled = false; btn.style.background = "#225588";
                        }
                        return data;
                    } catch (e) { led.style.backgroundColor = "red"; }
                };

                const downloadRow = async (row) => {
                    const payload = getRowPayload(row);
                    if(!payload.url || payload.url === "none") return;
                    
                    const led = row.querySelector(".asd-led");
                    const btn = row.querySelector(".asd-dl-btn");
                    btn.innerText = "⏳ Starting..."; btn.disabled = true; btn.style.background = "#555";
                    led.style.backgroundColor = "yellow";
                    
                    try {
                        await fetch("/academia/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
                        const poll = setInterval(async () => {
                            const data = await checkRowStatus(row);
                            if(data && data.exists && !data.is_downloading) clearInterval(poll);
                        }, 3000);
                    } catch (e) {}
                };

                let draggedRow = null;

                const addRow = (data = {}, isRestoring = false) => {
                    const isEnabled = data.enabled !== undefined ? data.enabled : true;
                    const isRealName = data.filename && data.filename !== "Direct Link" && data.filename !== "Pending...";
                    const showSelect = data.selected_url && data.selected_url.includes("huggingface.co/");
                    
                    const row = document.createElement("div");
                    row.className = `asd-dl-row ${isEnabled ? '' : 'disabled'}`;
                    
                    row.innerHTML = `
                        <div class="asd-drag-handle" draggable="true" title="Drag to reorder">⠿</div>
                        <label class="asd-switch">
                            <input type="checkbox" class="model-toggle" ${isEnabled ? 'checked' : ''}>
                            <span class="asd-slider"></span>
                        </label>
                        <input type="text" class="url-input asd-input" placeholder="URL (Civitai, HF...)" value="${data.url || ''}" style="flex: 2;">
                        <div style="flex: 2; position: relative;">
                            <select class="file-select asd-input" style="width: 100%; display: ${showSelect ? 'block' : 'none'}; background: #2a2a2a;"></select>
                            <input type="text" class="filename-input asd-input" value="${data.filename || 'Direct Link'}" style="width: 100%; display: ${showSelect ? 'none' : 'block'}; text-align: center; color: ${isRealName ? '#ddd' : '#888'};">
                        </div>
                        <div class="size-label" style="flex: 0.5; text-align: center; color: #aaa; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${data.filesize || '-- MB'}</div>
                        <select class="folder-select asd-input" style="flex: 1.2;">
                            ${folders.map(f => `<option value="${f}" ${data.folder === f ? 'selected' : ''}>${f}</option>`).join('')}
                        </select>
                        <input type="text" class="subfolder-input asd-input" placeholder="Subfolder" value="${data.subfolder || ''}" style="flex: 1;">
                        <button class="asd-btn asd-dl-btn" style="background: #225588;">Download</button>
                        <div class="asd-led" style="width: 14px; height: 14px; border-radius: 50%; background-color: red; box-shadow: 0 0 6px red; flex-shrink: 0;" title="Not downloaded"></div>
                        <button class="asd-del-btn" style="background: transparent; border: none; color: #888; cursor: pointer; padding: 0px 4px; font-size: 14px;">❌</button>
                    `;

                    // Si es HF, añadimos temporalmente el archivo que ya teníamos guardado para que no salga en blanco
                    if (showSelect) {
                        const sel = row.querySelector(".file-select");
                        const opt = document.createElement("option");
                        opt.value = data.selected_url; opt.innerText = data.filename;
                        sel.appendChild(opt);
                    } else if (!data.folder && folders.includes("loras")) {
                        row.querySelector(".folder-select").value = "loras";
                    }

                    row.querySelector(".model-toggle").addEventListener("change", (e) => {
                        if(e.target.checked) row.classList.remove("disabled"); else row.classList.add("disabled");
                    });

                    row.querySelector(".asd-del-btn").addEventListener("click", () => {
                        row.remove();
                        forceResize();
                    });

                    row.querySelector(".asd-dl-btn").addEventListener("click", () => downloadRow(row));

                    const handleUrlFetch = async (isRestoringCall = false) => {
                        const url = row.querySelector(".url-input").value;
                        const sel = row.querySelector(".file-select");
                        const fInput = row.querySelector(".filename-input");
                        const sizeLbl = row.querySelector(".size-label");
                        
                        if(!url) return;
                        if(!isRestoringCall) sizeLbl.innerText = "⏳...";
                        
                        try {
                            const res = await fetch("/academia/parse_url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, hf_token: container.querySelector("#asd-hf-token").value }) });
                            const parsed = await res.json();
                            
                            // Si estamos restaurando el JSON, queremos mantener el archivo que teníamos elegido, no resetearlo
                            const desiredSelection = isRestoringCall && data.selected_url ? data.selected_url : sel.value;
                            
                            if(parsed.type === "repo") {
                                sel.innerHTML = "";
                                parsed.files.forEach(f => {
                                    const opt = document.createElement("option");
                                    opt.value = f.url; 
                                    opt.innerText = f.name.split('/').pop().split('\\').pop(); 
                                    opt.dataset.size = f.size;
                                    sel.appendChild(opt);
                                });
                                sel.style.display = "block"; fInput.style.display = "none";
                                
                                if (Array.from(sel.options).some(o => o.value === desiredSelection)) {
                                    sel.value = desiredSelection;
                                }
                                
                                if (!isRestoringCall || sizeLbl.innerText === "-- MB" || sizeLbl.innerText === "Unknown") {
                                    sizeLbl.innerText = sel.options[sel.selectedIndex]?.dataset.size || "-- MB";
                                }
                            } else {
                                sel.style.display = "none"; fInput.style.display = "block";
                                if (!isRestoringCall) {
                                    fInput.value = "Direct Link"; fInput.style.color = "#888";
                                }
                            }
                            
                            // Si lo hemos tecleado a mano, comprobar su estado
                            if(!isRestoringCall) checkRowStatus(row);
                            
                        } catch(e) { if(!isRestoringCall) sizeLbl.innerText = "Error"; }
                    };

                    row.querySelector(".url-input").addEventListener("change", () => handleUrlFetch(false));
                    
                    row.querySelector(".file-select").addEventListener("change", () => {
                        const sel = row.querySelector(".file-select");
                        const opt = sel.options[sel.selectedIndex];
                        if (opt && opt.dataset.size) row.querySelector(".size-label").innerText = opt.dataset.size;
                        checkRowStatus(row);
                    });
                    
                    row.querySelector(".folder-select").addEventListener("change", () => checkRowStatus(row));
                    row.querySelector(".subfolder-input").addEventListener("change", () => checkRowStatus(row));
                    row.querySelector(".filename-input").addEventListener("change", () => checkRowStatus(row));
                    
                    const handle = row.querySelector(".asd-drag-handle");
                    handle.addEventListener("mousedown", () => { row.draggable = true; });
                    row.addEventListener("dragend", () => { row.draggable = false; draggedRow = null; row.classList.remove('drag-over-top', 'drag-over-bottom'); });
                    row.addEventListener('dragstart', (e) => { draggedRow = row; e.dataTransfer.effectAllowed = 'move'; setTimeout(() => row.style.opacity = '0.4', 0); });
                    row.addEventListener('dragover', (e) => {
                        e.preventDefault();
                        const rect = row.getBoundingClientRect();
                        if (e.clientY < rect.top + rect.height / 2) {
                            row.classList.add('drag-over-top'); row.classList.remove('drag-over-bottom');
                        } else {
                            row.classList.add('drag-over-bottom'); row.classList.remove('drag-over-top');
                        }
                    });
                    row.addEventListener('dragleave', () => { row.classList.remove('drag-over-top', 'drag-over-bottom'); });
                    row.addEventListener('drop', (e) => {
                        e.stopPropagation();
                        row.classList.remove('drag-over-top', 'drag-over-bottom');
                        if (draggedRow && draggedRow !== row) {
                            const rect = row.getBoundingClientRect();
                            if (e.clientY < rect.top + rect.height / 2) _this.rowsContainer.insertBefore(draggedRow, row);
                            else _this.rowsContainer.insertBefore(draggedRow, row.nextSibling);
                        }
                        return false;
                    });

                    _this.rowsContainer.appendChild(row);
                    if (!isRestoring) forceResize();
                    
                    // --- CORRECCIÓN MAGNA --- 
                    // Si estamos restaurando, obtenemos el listado completo de HF sin alterar la UI
                    if (data.url && data.url.startsWith("http")) {
                        setTimeout(() => handleUrlFetch(isRestoring), isRestoring ? 300 + Math.random() * 800 : 100); 
                    }
                };

                container.querySelector("#asd-btn-add").addEventListener("click", () => addRow());
                
                container.querySelector("#asd-btn-check").addEventListener("click", async () => {
                    Array.from(this.rowsContainer.children).forEach(r => checkRowStatus(r));
                });

                container.querySelector("#asd-btn-dl-all").addEventListener("click", async () => {
                    Array.from(this.rowsContainer.children).forEach(r => {
                        if(!r.querySelector(".model-toggle").checked) return;
                        const btn = r.querySelector(".asd-dl-btn"); 
                        const led = r.querySelector(".asd-led"); 
                        
                        if(led.style.backgroundColor === "red" || led.style.backgroundColor === "rgb(255, 0, 0)") {
                            btn.click(); 
                        } else if (led.style.backgroundColor === "rgb(255, 0, 255)") {
                            alert("A token is missing to download secure models.");
                        }
                    });
                });

                container.querySelector("#asd-btn-savetokens").addEventListener("click", async (e) => {
                    const btn = e.target;
                    try {
                        btn.innerText = "⌛...";
                        await fetch("/academia/tokens", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ civitai: container.querySelector("#asd-civ-token").value, huggingface: container.querySelector("#asd-hf-token").value }) });
                        btn.innerText = "✅ Saved!"; setTimeout(() => btn.innerText = "💾 Save Tokens", 2000);
                    } catch(e) { btn.innerText = "❌ Error"; }
                });

                const presetSel = container.querySelector("#asd-preset-sel");
                const refreshPresetsList = async () => {
                    try {
                        const res = await fetch("/academia/download_presets");
                        const data = await res.json();
                        if(data.status === "success") {
                            presetSel.innerHTML = "";
                            data.files.forEach(f => {
                                const opt = document.createElement("option"); opt.value = f; opt.innerText = f; presetSel.appendChild(opt);
                            });
                            if(data.files.length > 0) presetSel.value = data.files.includes(currentPreset) ? currentPreset : data.files[0];
                        }
                    } catch(e){}
                };

                container.querySelector("#asd-btn-load").addEventListener("click", async () => {
                    if(!presetSel.value) return;
                    try {
                        const res = await fetch(`/academia/download_presets?name=${presetSel.value}`);
                        const data = await res.json();
                        if(data.status === "success") {
                            _this.rowsContainer.innerHTML = "";
                            data.data.forEach(item => addRow(item, true));
                            currentPreset = presetSel.value;
                            forceResize();
                            setTimeout(() => { Array.from(_this.rowsContainer.children).forEach((r, idx) => setTimeout(() => checkRowStatus(r), idx * 200)); }, 500);
                        }
                    } catch(e){}
                });

                const saveToServer = async (presetName) => {
                    const models = [];
                    for(let row of this.rowsContainer.children) {
                        const selectFile = row.querySelector(".file-select");
                        const inputFilename = row.querySelector(".filename-input");
                        let filename = selectFile.style.display === "block" ? selectFile.options[selectFile.selectedIndex]?.text : inputFilename.value;
                        if (filename) filename = filename.split('/').pop().split('\\').pop();

                        models.push({
                            enabled: row.querySelector(".model-toggle").checked,
                            url: row.querySelector(".url-input").value,
                            selected_url: selectFile.style.display === "block" ? selectFile.value : row.querySelector(".url-input").value,
                            filename: filename,
                            filesize: row.querySelector(".size-label").innerText,
                            folder: row.querySelector(".folder-select").value,
                            subfolder: row.querySelector(".subfolder-input").value
                        });
                    }
                    try {
                        await fetch("/academia/download_presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: presetName, data: models }) });
                        currentPreset = presetName;
                        await refreshPresetsList();
                        container.querySelector("#asd-btn-save").innerText = "✅ Saved";
                        setTimeout(() => container.querySelector("#asd-btn-save").innerText = "💾 Save", 2000);
                    } catch(e){}
                };

                container.querySelector("#asd-btn-save").addEventListener("click", () => {
                    if(!currentPreset || currentPreset === "default") {
                        const name = prompt("Enter a name for this preset:", "My_Models");
                        if(name) saveToServer(name);
                    } else { saveToServer(currentPreset); }
                });

                container.querySelector("#asd-btn-saveas").addEventListener("click", () => {
                    const name = prompt("Enter a NEW name for this preset:", currentPreset + "_copy");
                    if(name) saveToServer(name);
                });

                container.querySelector("#asd-btn-export").addEventListener("click", () => {
                    const models = [];
                    for(let row of this.rowsContainer.children) {
                        const selectFile = row.querySelector(".file-select");
                        const inputFilename = row.querySelector(".filename-input");
                        let filename = selectFile.style.display === "block" ? selectFile.options[selectFile.selectedIndex]?.text : inputFilename.value;
                        if (filename) filename = filename.split('/').pop().split('\\').pop();

                        models.push({
                            enabled: row.querySelector(".model-toggle").checked,
                            url: row.querySelector(".url-input").value,
                            selected_url: selectFile.style.display === "block" ? selectFile.value : row.querySelector(".url-input").value,
                            filename: filename,
                            filesize: row.querySelector(".size-label").innerText,
                            folder: row.querySelector(".folder-select").value,
                            subfolder: row.querySelector(".subfolder-input").value
                        });
                    }
                    
                    let exportName = "academia_models";
                    if (models.length > 0 && models[0].filename && models[0].filename !== "Direct Link") {
                        exportName = "download_list_" + models[0].filename.replace(/\.[^/.]+$/, "");
                    }

                    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(models, null, 4));
                    const downloadAnchorNode = document.createElement('a');
                    downloadAnchorNode.setAttribute("href", dataStr);
                    downloadAnchorNode.setAttribute("download", exportName + ".json");
                    document.body.appendChild(downloadAnchorNode);
                    downloadAnchorNode.click();
                    downloadAnchorNode.remove();
                });

                const fileImportInput = container.querySelector("#asd-file-import");
                container.querySelector("#asd-btn-import").addEventListener("click", () => fileImportInput.click());
                fileImportInput.addEventListener("change", (e) => {
                    const file = e.target.files[0];
                    if(!file) return;
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        try {
                            const data = JSON.parse(event.target.result);
                            _this.rowsContainer.innerHTML = "";
                            data.forEach(item => addRow(item, true));
                            forceResize();
                            setTimeout(() => { Array.from(_this.rowsContainer.children).forEach((r, idx) => setTimeout(() => checkRowStatus(r), idx * 200)); }, 500);
                        } catch(err) { alert("Invalid JSON file."); }
                    };
                    reader.readAsText(file);
                    fileImportInput.value = ""; 
                });

                async function fetchFolders() {
                    try {
                        const res = await fetch("/academia/folders");
                        folders = await res.json();
                    } catch (e) {}
                }

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);
                
                // INITIALIZATION
                fetch("/academia/tokens").then(r => r.json()).then(d => {
                    if (d.civitai) container.querySelector("#asd-civ-token").value = d.civitai;
                    if (d.huggingface) container.querySelector("#asd-hf-token").value = d.huggingface;
                }).catch(()=>{});

                refreshPresetsList().then(() => {
                    fetchFolders().then(() => {
                        if (this.restored_models && this.restored_models.length > 0) {
                            this.restored_models.forEach(m => addRow(m, true));
                            setTimeout(() => { Array.from(this.rowsContainer.children).forEach((r, idx) => setTimeout(() => checkRowStatus(r), idx * 200)); }, 1000);
                        } else { addRow(); }
                    });
                });
            };
        }
    }
});
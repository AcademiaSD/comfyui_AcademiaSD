import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.Downloader",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_Downloader") {
            
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                
                if (this.tokenInput) {
                    o.civitai_token = this.tokenInput.value;
                }

                o.academia_models = [];
                if (this.rowsContainer) {
                    for(let row of this.rowsContainer.children) {
                        const url = row.querySelector(".url-input").value;
                        const selectFile = row.querySelector(".file-select");
                        const selected_url = selectFile.value;
                        const filename = selectFile.options[selectFile.selectedIndex]?.text || "";
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;
                        
                        if(url.trim() !== "") {
                            o.academia_models.push({ url, selected_url, filename, folder, subfolder });
                        }
                    }
                }
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                if (o.academia_models) this.restored_models = o.academia_models;
                if (o.civitai_token) this.restored_token = o.civitai_token;
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                this.size = [900, 240];
                let folders = [];

                const container = document.createElement("div");
                container.style.cssText = `
                    padding: 10px; color: white; background: #222; 
                    font-family: sans-serif; font-size: 13px; width: 100%; height: 100%;
                    box-sizing: border-box; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
                    border-radius: 5px;
                `;

                const topBar = document.createElement("div");
                topBar.style.display = "flex"; topBar.style.gap = "8px"; topBar.style.alignItems = "center";
                
                const btnAdd = document.createElement("button");
                btnAdd.innerText = "➕ Add Model";
                btnAdd.style.cssText = "cursor: pointer; padding: 5px 10px; background: #444; color: white; border: 1px solid #666; border-radius: 4px;";
                
                const btnRefresh = document.createElement("button");
                btnRefresh.innerText = "🔄 Refresh";
                btnRefresh.style.cssText = "cursor: pointer; padding: 5px 10px; background: #444; color: white; border: 1px solid #666; border-radius: 4px;";
                
                this.tokenInput = document.createElement("input");
                this.tokenInput.type = "password";
                this.tokenInput.placeholder = "Civitai API Key (Optional)";
                this.tokenInput.title = "Paste your Civitai API Key here to download secure/NSFW models";
                this.tokenInput.style.cssText = "flex: 1; padding: 5px; border-radius: 3px; border: 1px solid #555; outline: none; background: #111; color: white;";
                
                topBar.appendChild(btnAdd);
                topBar.appendChild(btnRefresh);
                topBar.appendChild(this.tokenInput);
                container.appendChild(topBar);

                this.rowsContainer = document.createElement("div");
                this.rowsContainer.style.display = "flex";
                this.rowsContainer.style.flexDirection = "column";
                this.rowsContainer.style.gap = "8px";
                container.appendChild(this.rowsContainer);

                const btnDownloadAll = document.createElement("button");
                btnDownloadAll.innerText = "⬇️ Download All";
                btnDownloadAll.style.cssText = "margin-top: auto; cursor: pointer; padding: 8px; background: #1a5c2b; color: white; border: 1px solid #2d9444; border-radius: 4px; font-weight: bold;";
                container.appendChild(btnDownloadAll);

                async function fetchFolders() {
                    try {
                        const res = await fetch("/academia/folders");
                        folders = await res.json();
                    } catch (e) {}
                }

                const addRow = (data = {}, isRestoring = false) => {
                    const row = document.createElement("div");
                    row.style.display = "flex"; row.style.gap = "8px"; row.style.alignItems = "center";
                    row.style.background = "#333"; row.style.padding = "5px"; row.style.borderRadius = "4px";

                    const inputUrl = document.createElement("input");
                    inputUrl.className = "url-input";
                    inputUrl.type = "text";
                    inputUrl.value = data.url || "";
                    inputUrl.placeholder = "URL (Civitai, HF Repository...)";
                    inputUrl.style.cssText = "flex: 2; padding: 4px; border-radius: 3px; border: none; outline: none; background: #111; color: white;";

                    const selectFile = document.createElement("select");
                    selectFile.className = "file-select";
                    selectFile.style.cssText = "flex: 2; padding: 4px; border-radius: 3px; border: none; background: #2a2a2a; color: white; display: none;";
                    
                    if (data.selected_url && data.filename) {
                        const opt = document.createElement("option");
                        opt.value = data.selected_url;
                        opt.innerText = data.filename;
                        selectFile.appendChild(opt);
                        selectFile.style.display = "block";
                    } else {
                        const opt = document.createElement("option");
                        opt.value = data.url || "none";
                        opt.innerText = "Direct Link";
                        selectFile.appendChild(opt);
                    }

                    const selectFolder = document.createElement("select");
                    selectFolder.className = "folder-select";
                    selectFolder.style.cssText = "flex: 1.2; padding: 4px; border-radius: 3px; border: none; background: #111; color: white;";
                    folders.forEach(f => {
                        const opt = document.createElement("option");
                        opt.value = f; opt.innerText = f;
                        selectFolder.appendChild(opt);
                    });
                    if (data.folder && folders.includes(data.folder)) selectFolder.value = data.folder;
                    else if (folders.includes("loras")) selectFolder.value = "loras";

                    const inputSubfolder = document.createElement("input");
                    inputSubfolder.className = "subfolder-input";
                    inputSubfolder.type = "text";
                    inputSubfolder.value = data.subfolder || "";
                    inputSubfolder.placeholder = "Subfolder (Opt.)";
                    inputSubfolder.style.cssText = "flex: 1; padding: 4px; border-radius: 3px; border: none; outline: none; background: #111; color: white;";

                    const btnDownload = document.createElement("button");
                    btnDownload.innerText = "Download";
                    btnDownload.style.cssText = "cursor: pointer; padding: 4px 8px; background: #225588; color: white; border: none; border-radius: 3px;";

                    const led = document.createElement("div");
                    led.style.cssText = "width: 14px; height: 14px; border-radius: 50%; background-color: red; box-shadow: 0 0 6px red; flex-shrink: 0;";
                    led.title = "Not downloaded yet";

                    const btnDelete = document.createElement("button");
                    btnDelete.innerText = "❌";
                    btnDelete.title = "Delete row";
                    btnDelete.style.cssText = "background: transparent; border: none; cursor: pointer; padding: 0px 4px;";
                    
                    const handleUrlFetch = async () => {
                        const url = inputUrl.value;
                        if(!url || !url.startsWith("http")) return;
                        
                        try {
                            const res = await fetch("/academia/parse_url", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ url })
                            });
                            const parsed = await res.json();
                            
                            const currentSelection = selectFile.value;
                            selectFile.innerHTML = "";
                            
                            if(parsed.type === "repo") {
                                parsed.files.forEach(f => {
                                    const opt = document.createElement("option");
                                    opt.value = f.url;
                                    opt.innerText = f.name;
                                    selectFile.appendChild(opt);
                                });
                                selectFile.style.display = "block";
                                if (Array.from(selectFile.options).some(opt => opt.value === currentSelection)) {
                                    selectFile.value = currentSelection;
                                }
                            } else {
                                const opt = document.createElement("option");
                                opt.value = url;
                                opt.innerText = "Direct Link";
                                selectFile.appendChild(opt);
                                selectFile.style.display = "none";
                            }
                            triggerCheck();
                        } catch(e) {}
                    };

                    const triggerCheck = async () => await checkStatus(selectFile.value, selectFolder.value, inputSubfolder.value, led, btnDownload);
                    
                    inputUrl.addEventListener("change", handleUrlFetch);
                    selectFile.addEventListener("change", triggerCheck);
                    selectFolder.addEventListener("change", triggerCheck);
                    inputSubfolder.addEventListener("change", triggerCheck);
                    this.tokenInput.addEventListener("change", triggerCheck); 

                    btnDownload.addEventListener("click", async () => {
                        await downloadFile(selectFile.value, selectFolder.value, inputSubfolder.value, led, btnDownload);
                    });

                    btnDelete.addEventListener("click", () => {
                        row.remove();
                        this.size[1] -= 42;
                    });

                    row.appendChild(inputUrl);
                    row.appendChild(selectFile);
                    row.appendChild(selectFolder);
                    row.appendChild(inputSubfolder);
                    row.appendChild(btnDownload);
                    row.appendChild(led);
                    row.appendChild(btnDelete);
                    this.rowsContainer.appendChild(row);

                    if (!isRestoring) this.size[1] += 42;
                    if (data.url && data.url.startsWith("http")) setTimeout(() => handleUrlFetch(), 500); 
                };

                const getPayload = (url, folder, subfolder) => ({
                    url, folder, subfolder, token: this.tokenInput.value
                });

                async function checkStatus(url, folder, subfolder, ledElement, btnElement) {
                    if(!url || url === "none" || !url.startsWith("http")) return;
                    ledElement.style.backgroundColor = "orange";
                    ledElement.style.boxShadow = "0 0 6px orange";
                    
                    try {
                        const res = await fetch("/academia/check", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(getPayload(url, folder, subfolder))
                        });
                        const data = await res.json();
                        
                        if (data.exists) {
                            ledElement.style.backgroundColor = "#00ff00";
                            ledElement.style.boxShadow = "0 0 8px #00ff00";
                            ledElement.title = `Ready: ${data.filename}`;
                            if(btnElement) { btnElement.innerText = "Completed"; btnElement.disabled = true; btnElement.style.background = "#008800"; }
                        } else if (data.is_downloading) {
                            ledElement.style.backgroundColor = "yellow";
                            ledElement.style.boxShadow = "0 0 6px yellow";
                            ledElement.title = `Downloading...`;
                            if(btnElement) { btnElement.innerText = "⏳ Downloading..."; btnElement.disabled = true; btnElement.style.background = "#555"; }
                        } else if (data.message === "auth_required") {
                            ledElement.style.backgroundColor = "#ff00ff";
                            ledElement.style.boxShadow = "0 0 6px #ff00ff";
                            ledElement.title = "API Key required!";
                            if(btnElement) { btnElement.innerText = "Need API Key"; btnElement.disabled = false; btnElement.style.background = "#aa00aa"; }
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

                async function downloadFile(url, folder, subfolder, ledElement, btnElement) {
                    if(!url || url === "none" || !url.startsWith("http")) return;
                    btnElement.innerText = "⏳ Starting...";
                    btnElement.disabled = true;
                    btnElement.style.background = "#555";
                    ledElement.style.backgroundColor = "yellow";
                    ledElement.style.boxShadow = "0 0 6px yellow";
                    
                    try {
                        await fetch("/academia/download", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(getPayload(url, folder, subfolder))
                        });
                        
                        // Sondeo seguro y recursivo: Garantiza que no se acumulen peticiones
                        const poll = async () => {
                            const data = await checkStatus(url, folder, subfolder, ledElement, btnElement);
                            if(data && data.exists && !data.is_downloading) {
                                return; // Termina el bucle
                            }
                            setTimeout(poll, 3000); // Pregunta de nuevo 3 segundos DESPUÉS de recibir respuesta
                        };
                        setTimeout(poll, 3000);

                    } catch (e) {
                        btnElement.innerText = "Error";
                        btnElement.disabled = false;
                        btnElement.style.background = "#cc0000";
                    }
                }

                btnAdd.addEventListener("click", () => addRow());
                
                btnRefresh.addEventListener("click", async () => {
                    for(let row of this.rowsContainer.children) {
                        const url = row.querySelector(".file-select").value; 
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;
                        const btn = row.children[4]; 
                        const led = row.children[5]; 
                        await checkStatus(url, folder, subfolder, led, btn);
                    }
                });

                btnDownloadAll.addEventListener("click", async () => {
                    for(let row of this.rowsContainer.children) {
                        const url = row.querySelector(".file-select").value; 
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;
                        const btn = row.children[4]; 
                        const led = row.children[5]; 
                        
                        if(led.style.backgroundColor === "red" || led.style.backgroundColor === "rgb(255, 0, 0)") {
                            await downloadFile(url, folder, subfolder, led, btn);
                        } else if (led.style.backgroundColor === "rgb(255, 0, 255)") {
                            alert("Please provide a Civitai API Key at the top to download secure models.");
                        }
                    }
                });

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);
                
                if (this.restored_token) {
                    this.tokenInput.value = this.restored_token;
                }

                fetchFolders().then(() => {
                    if (this.restored_models && this.restored_models.length > 0) {
                        this.restored_models.forEach(modelData => {
                            addRow(modelData, true);
                        });
                    } else {
                        addRow();
                    }
                });
            };
        }
    }
});
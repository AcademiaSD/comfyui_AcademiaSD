import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.Downloader",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_Downloader") {
            
            // GUARDAR DATOS (ahora incluye la subcarpeta)
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                o.academia_models = [];
                if (this.rowsContainer) {
                    for(let row of this.rowsContainer.children) {
                        const url = row.querySelector(".url-input").value;
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value; // Nuevo
                        if(url.trim() !== "") {
                            o.academia_models.push({ url, folder, subfolder });
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

                // Hacemos el nodo un poco más ancho (720px) para que quepa todo bien
                this.size = [720, 200];
                let folders = [];

                const container = document.createElement("div");
                container.style.cssText = `
                    padding: 10px; color: white; background: #222; 
                    font-family: sans-serif; font-size: 13px; width: 100%; height: 100%;
                    box-sizing: border-box; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
                    border-radius: 5px;
                `;

                const topBar = document.createElement("div");
                topBar.style.display = "flex"; topBar.style.gap = "8px";
                
                const btnAdd = document.createElement("button");
                btnAdd.innerText = "➕ Añadir Modelo";
                btnAdd.style.cssText = "cursor: pointer; flex: 1; padding: 5px; background: #444; color: white; border: 1px solid #666; border-radius: 4px;";
                
                const btnRefresh = document.createElement("button");
                btnRefresh.innerText = "🔄 Refrescar Estado";
                btnRefresh.style.cssText = "cursor: pointer; padding: 5px; background: #444; color: white; border: 1px solid #666; border-radius: 4px;";
                
                topBar.appendChild(btnAdd);
                topBar.appendChild(btnRefresh);
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

                // addRow ahora acepta la subcarpeta inicial
                const addRow = (initialUrl = "", initialFolder = "", initialSubfolder = "", isRestoring = false) => {
                    const row = document.createElement("div");
                    row.style.display = "flex"; row.style.gap = "8px"; row.style.alignItems = "center";
                    row.style.background = "#333"; row.style.padding = "5px"; row.style.borderRadius = "4px";

                    // 1. URL
                    const inputUrl = document.createElement("input");
                    inputUrl.className = "url-input";
                    inputUrl.type = "text";
                    inputUrl.value = initialUrl;
                    inputUrl.placeholder = "Pega aquí la URL";
                    inputUrl.style.cssText = "flex: 3; padding: 4px; border-radius: 3px; border: none; outline: none; background: #111; color: white;";

                    // 2. Carpeta Base
                    const selectFolder = document.createElement("select");
                    selectFolder.className = "folder-select";
                    selectFolder.style.cssText = "flex: 1.5; padding: 4px; border-radius: 3px; border: none; background: #111; color: white;";
                    
                    folders.forEach(f => {
                        const opt = document.createElement("option");
                        opt.value = f; opt.innerText = f;
                        selectFolder.appendChild(opt);
                    });
                    
                    if (initialFolder && folders.includes(initialFolder)) {
                        selectFolder.value = initialFolder;
                    } else if (folders.includes("loras")) {
                        selectFolder.value = "loras";
                    }

                    // 3. Subcarpeta (NUEVO)
                    const inputSubfolder = document.createElement("input");
                    inputSubfolder.className = "subfolder-input";
                    inputSubfolder.type = "text";
                    inputSubfolder.value = initialSubfolder || ""; // Evita undefined en workflows antiguos
                    inputSubfolder.placeholder = "Subcarpeta (Opc.)";
                    inputSubfolder.style.cssText = "flex: 1.5; padding: 4px; border-radius: 3px; border: none; outline: none; background: #111; color: white;";

                    // 4. Botones
                    const btnDownload = document.createElement("button");
                    btnDownload.innerText = "Descargar";
                    btnDownload.style.cssText = "cursor: pointer; padding: 4px 8px; background: #225588; color: white; border: none; border-radius: 3px;";

                    const led = document.createElement("div");
                    led.style.cssText = "width: 14px; height: 14px; border-radius: 50%; background-color: red; box-shadow: 0 0 6px red; flex-shrink: 0;";
                    led.title = "Aún no descargado";

                    const btnDelete = document.createElement("button");
                    btnDelete.innerText = "❌";
                    btnDelete.title = "Eliminar fila";
                    btnDelete.style.cssText = "background: transparent; border: none; cursor: pointer; padding: 0px 4px;";
                    
                    // Eventos: actualizamos el trigger para incluir subcarpeta
                    const triggerCheck = async () => await checkStatus(inputUrl.value, selectFolder.value, inputSubfolder.value, led, btnDownload);
                    inputUrl.addEventListener("change", triggerCheck);
                    selectFolder.addEventListener("change", triggerCheck);
                    inputSubfolder.addEventListener("change", triggerCheck);

                    btnDownload.addEventListener("click", async () => {
                        await downloadFile(inputUrl.value, selectFolder.value, inputSubfolder.value, led, btnDownload);
                    });

                    btnDelete.addEventListener("click", () => {
                        row.remove();
                        this.size[1] -= 42;
                    });

                    row.appendChild(inputUrl);
                    row.appendChild(selectFolder);
                    row.appendChild(inputSubfolder);
                    row.appendChild(btnDownload);
                    row.appendChild(led);
                    row.appendChild(btnDelete);
                    this.rowsContainer.appendChild(row);

                    if (!isRestoring) this.size[1] += 42;
                    if (initialUrl) setTimeout(triggerCheck, 1000);
                };

                // Actualizadas para enviar la "subfolder" al Backend
                async function checkStatus(url, folder, subfolder, ledElement, btnElement) {
                    if(!url) return;
                    ledElement.style.backgroundColor = "orange";
                    ledElement.style.boxShadow = "0 0 6px orange";
                    
                    try {
                        const res = await fetch("/academia/check", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ url, folder, subfolder }) // <--- Nuevo
                        });
                        const data = await res.json();
                        
                        if (data.exists) {
                            ledElement.style.backgroundColor = "#00ff00";
                            ledElement.style.boxShadow = "0 0 8px #00ff00";
                            ledElement.title = `Listo: ${data.filename}`;
                            if(btnElement) { btnElement.innerText = "Completado"; btnElement.disabled = true; btnElement.style.background = "#008800"; }
                        } else if (data.is_downloading) {
                            ledElement.style.backgroundColor = "yellow";
                            ledElement.style.boxShadow = "0 0 6px yellow";
                            ledElement.title = `Descargando en proceso...`;
                            if(btnElement) { btnElement.innerText = "⏳ Descargando..."; btnElement.disabled = true; btnElement.style.background = "#555"; }
                        } else {
                            ledElement.style.backgroundColor = "red";
                            ledElement.style.boxShadow = "0 0 6px red";
                            ledElement.title = "Falta descargar";
                            if(btnElement) { btnElement.innerText = "Descargar"; btnElement.disabled = false; btnElement.style.background = "#225588"; }
                        }
                        return data;
                    } catch (e) {
                        ledElement.style.backgroundColor = "red";
                    }
                }

                async function downloadFile(url, folder, subfolder, ledElement, btnElement) {
                    if(!url) return;
                    btnElement.innerText = "⏳ Iniciando...";
                    btnElement.disabled = true;
                    btnElement.style.background = "#555";
                    ledElement.style.backgroundColor = "yellow";
                    ledElement.style.boxShadow = "0 0 6px yellow";
                    
                    try {
                        await fetch("/academia/download", {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ url, folder, subfolder }) // <--- Nuevo
                        });
                        
                        const pollInterval = setInterval(async () => {
                            const data = await checkStatus(url, folder, subfolder, ledElement, btnElement);
                            if(data && data.exists && !data.is_downloading) {
                                clearInterval(pollInterval);
                            }
                        }, 3000);

                    } catch (e) {
                        console.error("[AcademiaSD] Error al iniciar descarga", e);
                        btnElement.innerText = "Error";
                        btnElement.disabled = false;
                        btnElement.style.background = "#cc0000";
                    }
                }

                btnAdd.addEventListener("click", () => addRow());
                
                btnRefresh.addEventListener("click", async () => {
                    const rows = this.rowsContainer.children;
                    for(let row of rows) {
                        const url = row.querySelector(".url-input").value;
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;
                        const led = row.children[4]; // Índice ajustado por el nuevo input
                        const btn = row.children[3]; // Índice ajustado
                        await checkStatus(url, folder, subfolder, led, btn);
                    }
                });

                btnDownloadAll.addEventListener("click", async () => {
                    const rows = this.rowsContainer.children;
                    for(let row of rows) {
                        const url = row.querySelector(".url-input").value;
                        const folder = row.querySelector(".folder-select").value;
                        const subfolder = row.querySelector(".subfolder-input").value;
                        const btn = row.children[3]; // Índice ajustado
                        const led = row.children[4]; // Índice ajustado
                        
                        if(led.style.backgroundColor === "red" || led.style.backgroundColor === "rgb(255, 0, 0)") {
                            await downloadFile(url, folder, subfolder, led, btn);
                        }
                    }
                });

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);
                
                fetchFolders().then(() => {
                    if (this.restored_models && this.restored_models.length > 0) {
                        this.restored_models.forEach(model => {
                            // Al cargar worflows viejos, model.subfolder podría no existir, pero addRow lo maneja con || ""
                            addRow(model.url, model.folder, model.subfolder, true);
                        });
                    } else {
                        addRow();
                    }
                });
            };
        }
    }
});
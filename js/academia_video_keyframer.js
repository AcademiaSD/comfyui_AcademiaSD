import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "AcademiaSD.VideoKeyframer",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_VideoKeyframer") {
            
            // --- PERSISTENCIA DE DATOS ---
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                const dataWidget = this.widgets.find(w => w.name === "kf_data");
                if (dataWidget && this.kfState) {
                    dataWidget.value = JSON.stringify(this.kfState);
                }
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                const dataWidget = this.widgets.find(w => w.name === "kf_data");
                if (dataWidget && dataWidget.value) {
                    try {
                        this.kfState = JSON.parse(dataWidget.value);
                    } catch (e) {
                        console.error("[AcademiaSD] Error restoring state:", e);
                    }
                }
                if (this.renderUI) this.renderUI();
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const _this = this;

                if (!this.kfState) {
                    this.kfState =[
                        { image: "", frames: 33 },
                        { image: "", frames: 33 }
                    ];
                }

                const dataWidget = this.widgets.find(w => w.name === "kf_data");
                const fpsWidget = this.widgets.find(w => w.name === "fps");
                
                if (dataWidget) {
                    dataWidget.type = "hidden";
                    dataWidget.computeSize = () =>[0, -4]; 
                    dataWidget.draw = function() {}; 
                }

                for (let i = this.inputs ? this.inputs.length - 1 : -1; i >= 0; i--) {
                    if (this.inputs[i].type === "IMAGE") {
                        this.removeInput(i);
                    }
                }

                this.size =[440, 200];
                let inputImages =[];

                const container = document.createElement("div");
                container.style.cssText = `
                    width: 100%; display: flex; flex-direction: column; gap: 4px;
                    font-family: sans-serif; box-sizing: border-box; margin-top: 10px;
                    padding-bottom: 25px;
                `;

                const style = document.createElement("style");
                style.innerHTML = `
                    .asd-kf-box { background: #222; border: 1px solid #444; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 6px;}
                    .asd-kf-header { display: flex; justify-content: space-between; align-items: center; color: #ccc; font-size: 12px; font-weight: bold;}
                    
                    /* CAJA DE IMAGEN MÁS ALTA: Ahora 200px */
                    .asd-dropzone { height: 200px; border: 2px dashed #555; border-radius: 4px; display: flex; justify-content: center; align-items: center; cursor: pointer; overflow: hidden; background: #000; position: relative; transition: border 0.2s;}
                    .asd-dropzone:hover { border-color: #888; }
                    .asd-dropzone img { width: 100%; height: 100%; object-fit: contain; }
                    .asd-dropzone span { color: #666; font-size: 12px; pointer-events: none;}
                    
                    .asd-interval { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 4px 0; }
                    .asd-interval-line { flex: 1; height: 2px; background: #444; border-radius: 2px;}
                    .asd-frames-input { width: 45px; padding: 2px 4px; border: 1px solid #555; background: #111; color: #4a6ee0; outline: none; text-align: center; border-radius: 4px; font-family: monospace; font-size: 12px; font-weight: bold;}
                    .asd-time { color: #888; font-size: 11px; font-family: monospace; width: 45px;}
                    
                    .asd-del-btn { background: transparent; border: none; color: #888; cursor: pointer; transition: 0.2s; font-size: 12px;}
                    .asd-del-btn:hover { color: #ff4444; }
                `;
                container.appendChild(style);

                this.rowsContainer = document.createElement("div");
                this.rowsContainer.style.display = "flex";
                this.rowsContainer.style.flexDirection = "column";
                container.appendChild(this.rowsContainer);

                const btnAdd = document.createElement("button");
                btnAdd.innerText = "➕ Add Keyframe";
                btnAdd.style.cssText = "cursor: pointer; padding: 10px; background: #225588; color: white; border: none; border-radius: 4px; font-weight: bold; font-size: 12px; margin-top: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.3); transition: background 0.2s;";
                btnAdd.onmouseover = () => btnAdd.style.background = "#2b6cb0";
                btnAdd.onmouseout = () => btnAdd.style.background = "#225588";
                container.appendChild(btnAdd);

                // --- 🛡️ LA NUEVA MATEMÁTICA DE TAMAÑO (Corregido ancho y alto) 🛡️ ---
                const MIN_WIDTH = 440;

                this.computeSize = function(out) {
                    // Altura base = título + conectores de salida + conectores de entrada nativos
                    let baseH = 110; 
                    if (this.inputs) baseH += this.inputs.length * 20; 
                    
                    // Cálculo matemático rígido del contenido
                    let N = this.kfState ? this.kfState.length : 0;
                    
                    // 245 por cada caja de keyframe (200px de foto + padding + titulo)
                    // 35 por intervalo, 80 para el botón inferior y padding
                    let htmlH = (N * 245) + (Math.max(0, N - 1) * 35) + 80; 
                    
                    // 🔴 FIX: Devolver MIN_WIDTH absoluto. Esto permite encoger libremente el nodo de vuelta a 440
                    return [MIN_WIDTH, baseH + htmlH];
                };

                const originalOnResize = this.onResize;
                this.onResize = function(size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    
                    const minSize = this.computeSize();
                    // Bloqueamos el "aplastamiento" vertical por debajo de lo necesario
                    if (size[1] < minSize[1]) size[1] = minSize[1];
                    // Bloqueamos el estrechamiento por debajo de 440px
                    if (size[0] < minSize[0]) size[0] = minSize[0];
                };

                const forceResize = () => {
                    setTimeout(() => {
                        const minSize = _this.computeSize();
                        // Al redimensionar por código, respetamos el ancho que el usuario tuviera
                        _this.setSize([Math.max(_this.size[0], MIN_WIDTH), minSize[1]]);
                        app.graph.setDirtyCanvas(true, true);
                    }, 15);
                };

                // --- LÓGICA VISUAL ---
                const updateData = () => {
                    if (dataWidget) dataWidget.value = JSON.stringify(_this.kfState);
                    app.graph.setDirtyCanvas(true, false);
                };

                const calculateTime = (frames, timeSpan) => {
                    const fps = fpsWidget ? parseFloat(fpsWidget.value) : 24.0;
                    const time = (frames / fps).toFixed(2);
                    if(timeSpan) timeSpan.innerText = `(${time}s)`;
                };

                if (fpsWidget) {
                    const oldCallback = fpsWidget.callback;
                    fpsWidget.callback = function(val) {
                        if (oldCallback) oldCallback.apply(this, arguments);
                        _this.renderUI(); 
                    };
                }

                const uploadFile = async (file, kfIndex) => {
                    if (!file) return;
                    const formData = new FormData();
                    formData.append("image", file);
                    try {
                        const res = await fetch("/upload/image", { method: "POST", body: formData });
                        const data = await res.json();
                        _this.kfState[kfIndex].image = data.name;
                        updateData();
                        _this.renderUI();
                    } catch(e) {
                        console.error("[AcademiaSD] Error uploading", e);
                    }
                };

                async function fetchImages() {
                    try {
                        const res = await fetch("/academia/input_images");
                        inputImages = await res.json();
                        _this.renderUI();
                    } catch (e) {}
                }

                this.renderUI = () => {
                    _this.rowsContainer.innerHTML = "";

                    _this.kfState.forEach((item, idx) => {
                        const kfBox = document.createElement("div");
                        kfBox.className = "asd-kf-box";
                        
                        const header = document.createElement("div");
                        header.className = "asd-kf-header";
                        
                        const title = document.createElement("span");
                        title.innerText = idx === 0 ? "🎬 Base Frame" : `🎬 Target Keyframe ${idx}`;
                        header.appendChild(title);
                        
                        if (idx > 0) {
                            const btnDelete = document.createElement("button");
                            btnDelete.className = "asd-del-btn";
                            btnDelete.innerText = "❌";
                            btnDelete.addEventListener("click", () => {
                                _this.kfState.splice(idx, 1);
                                updateData();
                                _this.renderUI();
                            });
                            header.appendChild(btnDelete);
                        } else {
                            const ghost = document.createElement("div");
                            ghost.style.width = "16px";
                            header.appendChild(ghost);
                        }
                        
                        kfBox.appendChild(header);

                        const dropzone = document.createElement("div");
                        dropzone.className = "asd-dropzone";
                        
                        if (item.image) {
                            const img = document.createElement("img");
                            img.src = api.apiURL(`/view?filename=${encodeURIComponent(item.image)}&type=input&t=${Date.now()}`);
                            dropzone.appendChild(img);
                        } else {
                            const hint = document.createElement("span");
                            hint.innerText = "Drag & Drop Image Here";
                            dropzone.appendChild(hint);
                        }

                        const fileInput = document.createElement("input");
                        fileInput.type = "file";
                        fileInput.accept = "image/*";
                        fileInput.style.display = "none";
                        
                        dropzone.addEventListener("click", () => fileInput.click());
                        fileInput.addEventListener("change", (e) => uploadFile(e.target.files[0], idx));

                        dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.style.borderColor = "#4a6ee0"; });
                        dropzone.addEventListener("dragleave", (e) => { e.preventDefault(); dropzone.style.borderColor = "#555"; });
                        dropzone.addEventListener("drop", (e) => {
                            e.preventDefault();
                            dropzone.style.borderColor = "#555";
                            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                uploadFile(e.dataTransfer.files[0], idx);
                            }
                        });

                        kfBox.appendChild(dropzone);
                        kfBox.appendChild(fileInput);
                        _this.rowsContainer.appendChild(kfBox);

                        if (idx < _this.kfState.length - 1) {
                            const interval = document.createElement("div");
                            interval.className = "asd-interval";
                            
                            const line1 = document.createElement("div"); line1.className = "asd-interval-line";
                            const line2 = document.createElement("div"); line2.className = "asd-interval-line";
                            
                            const inputFrames = document.createElement("input");
                            inputFrames.type = "number";
                            inputFrames.className = "asd-frames-input";
                            inputFrames.title = "Frames (Auto adjusts to 8N+1)";
                            
                            inputFrames.value = _this.kfState[idx + 1].frames || 33;
                            
                            const timeSpan = document.createElement("span");
                            timeSpan.className = "asd-time";
                            calculateTime(inputFrames.value, timeSpan);

                            inputFrames.addEventListener("blur", function() {
                                let val = parseInt(this.value);
                                if (isNaN(val)) val = 33;
                                val = Math.max(9, Math.round((val - 1) / 8) * 8 + 1);
                                this.value = val;
                                _this.kfState[idx + 1].frames = val;
                                calculateTime(val, timeSpan);
                                updateData();
                            });
                            
                            inputFrames.addEventListener("keydown", function(e) {
                                if (e.key === "Enter") this.blur();
                            });

                            interval.appendChild(line1);
                            interval.appendChild(document.createTextNode("⬇️"));
                            interval.appendChild(inputFrames);
                            interval.appendChild(timeSpan);
                            interval.appendChild(line2);
                            
                            _this.rowsContainer.appendChild(interval);
                        }
                    });

                    forceResize();
                };

                btnAdd.addEventListener("click", () => {
                    _this.kfState.push({ image: "", frames: 33 });
                    updateData();
                    _this.renderUI();
                });

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);

                // INICIALIZACIÓN
                setTimeout(() => {
                    if (dataWidget && dataWidget.value && dataWidget.value !== "[]" && dataWidget.value !== "") {
                        try {
                            kfState = JSON.parse(dataWidget.value);
                        } catch (e) {}
                    } else {
                        // Iniciar con 2 imágenes por defecto
                        kfState =[
                            { image: "", frames: 33 },
                            { image: "", frames: 33 }
                        ];
                    }
                    renderUI();
                }, 100);
            };
        }
    }
});
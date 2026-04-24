import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "AcademiaSD.LTXVMultiFrames",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_LTXVMultiFrames") {
            
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
                    try { this.kfState = JSON.parse(dataWidget.value); } catch (e) {}
                }
                if (this.renderUI) this.renderUI();
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const _this = this;

                if (!this.kfState) {
                    this.kfState =[
                        { image: "", index: 0, strength: 0.8 }, 
                        { image: "", index: -1, strength: 0.8 }
                    ];
                }

                const dataWidget = this.widgets.find(w => w.name === "kf_data");
                if (dataWidget) {
                    dataWidget.type = "hidden";
                    dataWidget.computeSize = () =>[0, -4]; 
                    dataWidget.draw = function() {}; 
                }

                this.size =[440, 200];

                const container = document.createElement("div");
                container.style.cssText = `
                    width: 100%; display: flex; flex-direction: column; gap: 4px;
                    font-family: sans-serif; box-sizing: border-box; margin-top: 10px;
                    padding-bottom: 25px;
                `;

                // --- ESTILOS CSS REPARADOS PARA LOS INPUTS ---
                const style = document.createElement("style");
                style.innerHTML = `
                    .asd-mf-box { background: #222; border: 1px solid #444; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 6px;}
                    .asd-mf-header { display: flex; justify-content: space-between; align-items: center; color: #ccc; font-size: 12px; font-weight: bold;}
                    .asd-mf-dropzone { height: 160px; border: 2px dashed #555; border-radius: 4px; display: flex; justify-content: center; align-items: center; cursor: pointer; overflow: hidden; background: #000; position: relative;}
                    .asd-mf-dropzone:hover { border-color: #888; }
                    .asd-mf-dropzone img { width: 100%; height: 100%; object-fit: contain; }
                    .asd-mf-dropzone span { color: #666; font-size: 12px; pointer-events: none;}
                    
                    /* CAJAS DE PROPIEDADES FLEXIBLES */
                    .asd-mf-props { display: flex; gap: 10px; align-items: center; background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; width: 100%; box-sizing: border-box;}
                    .asd-mf-prop { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; }
                    .asd-mf-prop label { color: #aaa; font-size: 11px; font-weight: bold; width: 55px; flex-shrink: 0;}
                    .asd-mf-prop input { flex: 1; width: 100%; min-width: 0; background: #111; color: #4a6ee0; border: 1px solid #555; border-radius: 4px; padding: 4px; text-align: center; font-family: monospace; font-size: 13px; font-weight: bold; outline: none; box-sizing: border-box;}
                    
                    .asd-del-btn { background: transparent; border: none; color: #888; cursor: pointer; transition: 0.2s; font-size: 12px;}
                    .asd-del-btn:hover { color: #ff4444; }

                    /* Quitar flechas de los input type="number" */
                    .asd-mf-prop input[type="number"]::-webkit-inner-spin-button, 
                    .asd-mf-prop input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
                    .asd-mf-prop input[type="number"] { -moz-appearance: textfield; }
                `;
                container.appendChild(style);

                this.rowsContainer = document.createElement("div");
                this.rowsContainer.style.display = "flex";
                this.rowsContainer.style.flexDirection = "column";
                this.rowsContainer.style.gap = "6px";
                container.appendChild(this.rowsContainer);

                const btnAdd = document.createElement("button");
                btnAdd.innerText = "➕ Add Image Keyframe";
                btnAdd.style.cssText = "cursor: pointer; padding: 10px; background: #225588; color: white; border: none; border-radius: 4px; font-weight: bold; font-size: 12px; margin-top: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.3); transition: background 0.2s;";
                btnAdd.onmouseover = () => btnAdd.style.background = "#2b6cb0";
                btnAdd.onmouseout = () => btnAdd.style.background = "#225588";
                container.appendChild(btnAdd);

                const MIN_WIDTH = 320; // Bajamos el mínimo absoluto para permitir estrechar más

                this.computeSize = function(out) {
                    let baseH = 80; 
                    let N = _this.kfState ? _this.kfState.length : 0;
                    let htmlH = (N * 240) + 85; 
                    return[MIN_WIDTH, baseH + htmlH];
                };

                const originalOnResize = this.onResize;
                this.onResize = function(size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    const minSize = this.computeSize();
                    if (size[1] < minSize[1]) size[1] = minSize[1];
                    if (size[0] < minSize[0]) size[0] = minSize[0];
                };

                const forceResize = () => {
                    setTimeout(() => {
                        const minSize = _this.computeSize();
                        _this.setSize([Math.max(_this.size[0], MIN_WIDTH), minSize[1]]);
                        app.graph.setDirtyCanvas(true, true);
                    }, 15);
                };

                const updateData = () => {
                    if (dataWidget) dataWidget.value = JSON.stringify(_this.kfState);
                    forceResize();
                    app.graph.setDirtyCanvas(true, false);
                };

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
                    } catch(e) {}
                };

                this.renderUI = () => {
                    _this.rowsContainer.innerHTML = "";

                    _this.kfState.forEach((item, idx) => {
                        const kfBox = document.createElement("div");
                        kfBox.className = "asd-mf-box";
                        
                        const header = document.createElement("div");
                        header.className = "asd-mf-header";
                        const title = document.createElement("span");
                        title.innerText = `🖼️ LTXV Image ${idx + 1}`;
                        header.appendChild(title);
                        
                        const btnDelete = document.createElement("button");
                        btnDelete.className = "asd-del-btn";
                        btnDelete.innerText = "❌";
                        btnDelete.addEventListener("click", () => {
                            _this.kfState.splice(idx, 1);
                            updateData();
                            _this.renderUI();
                        });
                        header.appendChild(btnDelete);
                        kfBox.appendChild(header);

                        const dropzone = document.createElement("div");
                        dropzone.className = "asd-mf-dropzone";
                        
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
                            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) uploadFile(e.dataTransfer.files[0], idx);
                        });

                        kfBox.appendChild(dropzone);
                        kfBox.appendChild(fileInput);

                        // --- CONTROLES INDEX Y STRENGTH ---
                        const propsRow = document.createElement("div");
                        propsRow.className = "asd-mf-props";

                        const pIndex = document.createElement("div");
                        pIndex.className = "asd-mf-prop";
                        const lIndex = document.createElement("label"); lIndex.innerText = "Index:";
                        const iIndex = document.createElement("input");
                        iIndex.type = "number";
                        iIndex.value = item.index;
                        iIndex.addEventListener("blur", function() {
                            let val = parseInt(this.value);
                            if (isNaN(val)) val = 0;
                            this.value = val;
                            _this.kfState[idx].index = val;
                            updateData();
                        });
                        iIndex.addEventListener("keydown", function(e) { if(e.key === "Enter") this.blur(); });
                        pIndex.appendChild(lIndex); pIndex.appendChild(iIndex);

                        const pStrength = document.createElement("div");
                        pStrength.className = "asd-mf-prop";
                        const lStrength = document.createElement("label"); lStrength.innerText = "Strength:";
                        const iStrength = document.createElement("input");
                        iStrength.type = "text"; 
                        iStrength.value = parseFloat(item.strength).toFixed(2);
                        iStrength.addEventListener("input", function() {
                            this.value = this.value.replace(/,/g, '.').replace(/(?!^-)[^0-9.]/g, '');
                            if ((this.value.match(/\./g) ||[]).length > 1) this.value = this.value.slice(0, -1);
                        });
                        iStrength.addEventListener("blur", function() {
                            let val = parseFloat(this.value);
                            if (isNaN(val)) val = 0.8;
                            this.value = val.toFixed(2);
                            _this.kfState[idx].strength = val;
                            updateData();
                        });
                        iStrength.addEventListener("keydown", function(e) { if(e.key === "Enter") this.blur(); });
                        pStrength.appendChild(lStrength); pStrength.appendChild(iStrength);

                        propsRow.appendChild(pIndex);
                        propsRow.appendChild(pStrength);
                        kfBox.appendChild(propsRow);

                        _this.rowsContainer.appendChild(kfBox);
                    });

                    forceResize();
                };

                btnAdd.addEventListener("click", () => {
                    if (_this.kfState.length > 0 && _this.kfState[_this.kfState.length - 1].index === -1) {
                        _this.kfState[_this.kfState.length - 1].index = 0;
                    }
                    _this.kfState.push({ image: "", index: -1, strength: 0.8 });
                    updateData();
                    _this.renderUI();
                });

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);

                setTimeout(() => {
                    if (dataWidget && dataWidget.value && dataWidget.value !== "[]" && dataWidget.value !== "") {
                        try { _this.kfState = JSON.parse(dataWidget.value); } catch (e) {}
                    }
                    fetchImages();
                }, 100);
            };
        }
    }
});
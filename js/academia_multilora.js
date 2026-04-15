import { app } from "../../scripts/app.js";

// Crear un Tooltip flotante global (solo se crea una vez en todo ComfyUI)
let loraTooltip = document.getElementById("asd-lora-tooltip");
if (!loraTooltip) {
    loraTooltip = document.createElement("div");
    loraTooltip.id = "asd-lora-tooltip";
    loraTooltip.style.cssText = `
        position: fixed; background: rgba(20, 20, 20, 0.95); color: #fff; 
        border: 1px solid #555; padding: 10px; border-radius: 6px; 
        z-index: 999999; display: none; pointer-events: none; 
        font-family: monospace; font-size: 13px; line-height: 1.4;
        white-space: pre-wrap; max-width: 400px; box-shadow: 0 4px 10px rgba(0,0,0,0.6);
        backdrop-filter: blur(4px);
    `;
    document.body.appendChild(loraTooltip);
}

// Caché para no bombardear al servidor con peticiones del mismo LoRA
const loraMetadataCache = {};

app.registerExtension({
    name: "AcademiaSD.MultiLora",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_MultiLora") {
            
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const dataWidget = this.widgets.find(w => w.name === "lora_data");
                if (dataWidget) {
                    dataWidget.type = "hidden";
                    dataWidget.computeSize = () => [0, -4]; 
                    dataWidget.draw = function() {}; 
                }

                this.size = [420, 130];
                let loraList = [];

                const container = document.createElement("div");
                container.style.cssText = `
                    width: 100%; display: flex; flex-direction: column; gap: 6px;
                    font-family: sans-serif; box-sizing: border-box; margin-top: 4px;
                `;

                const style = document.createElement("style");
                style.innerHTML = `
                    .asd-switch { position: relative; display: inline-block; width: 32px; height: 16px; flex-shrink: 0;}
                    .asd-switch input { opacity: 0; width: 0; height: 0; }
                    .asd-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #555; transition: .2s; border-radius: 16px; }
                    .asd-slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 2px; bottom: 2px; background-color: #aaa; transition: .2s; border-radius: 50%; }
                    .asd-switch input:checked + .asd-slider { background-color: #4a6ee0; }
                    .asd-switch input:checked + .asd-slider:before { transform: translateX(16px); background-color: white; }
                    
                    .asd-lora-row { display: flex; align-items: center; gap: 6px; background: rgba(0,0,0,0.3); border: 1px solid #444; border-radius: 6px; padding: 4px 6px; transition: opacity 0.2s;}
                    .asd-lora-row.disabled { opacity: 0.5; }
                    
                    .lora-select { background-color: transparent; }
                    .lora-select option { background-color: #2b2b2b; color: #ffffff; }

                    .asd-step-btn { background: transparent; border: none; color: #888; font-size: 14px; font-weight: bold; cursor: pointer; padding: 0 4px; transition: color 0.2s; user-select: none; }
                    .asd-step-btn:hover { color: #fff; }
                `;
                container.appendChild(style);

                const topBar = document.createElement("div");
                topBar.style.display = "flex"; 
                topBar.style.justifyContent = "space-between";
                topBar.style.alignItems = "center";
                topBar.style.padding = "0 2px";
                
                const toggleAllContainer = document.createElement("div");
                toggleAllContainer.style.display = "flex"; 
                toggleAllContainer.style.alignItems = "center"; 
                toggleAllContainer.style.gap = "8px";
                
                const labelToggleAll = document.createElement("label");
                labelToggleAll.className = "asd-switch";
                const inputToggleAll = document.createElement("input");
                inputToggleAll.type = "checkbox";
                inputToggleAll.checked = true;
                const spanSliderAll = document.createElement("span");
                spanSliderAll.className = "asd-slider";
                labelToggleAll.appendChild(inputToggleAll);
                labelToggleAll.appendChild(spanSliderAll);
                
                const textToggleAll = document.createElement("span");
                textToggleAll.innerText = "Toggle All";
                textToggleAll.style.cssText = "color: #ccc; font-size: 11px; font-weight: bold;";
                
                toggleAllContainer.appendChild(labelToggleAll);
                toggleAllContainer.appendChild(textToggleAll);

                const btnRefresh = document.createElement("button");
                btnRefresh.innerText = "🔄 Refresh List";
                btnRefresh.style.cssText = "cursor: pointer; background: transparent; color: #888; border: none; font-size: 10px;";
                
                topBar.appendChild(toggleAllContainer);
                topBar.appendChild(btnRefresh);
                container.appendChild(topBar);

                this.rowsContainer = document.createElement("div");
                this.rowsContainer.style.display = "flex";
                this.rowsContainer.style.flexDirection = "column";
                this.rowsContainer.style.gap = "2px";
                container.appendChild(this.rowsContainer);

                const btnAdd = document.createElement("button");
                btnAdd.innerText = "➕ Add Lora";
                btnAdd.style.cssText = "cursor: pointer; padding: 4px; background: rgba(255,255,255,0.05); color: #aaa; border: 1px solid #444; border-radius: 6px; font-weight: bold; margin-top: 2px; font-size: 11px; transition: background 0.2s;";
                btnAdd.onmouseover = () => btnAdd.style.background = "rgba(255,255,255,0.1)";
                btnAdd.onmouseout = () => btnAdd.style.background = "rgba(255,255,255,0.05)";
                container.appendChild(btnAdd);

                const updateData = () => {
                    if (!dataWidget) return;
                    const data = [];
                    let allChecked = true;
                    let allUnchecked = true;

                    for(let row of this.rowsContainer.children) {
                        const enabled = row.querySelector(".lora-toggle").checked;
                        const name = row.querySelector(".lora-select").value;
                        const strength = row.querySelector(".lora-strength").value;
                        data.push({ enabled, name, strength });
                        
                        if (enabled) allUnchecked = false;
                        else allChecked = false;
                    }
                    
                    if (this.rowsContainer.children.length > 0) {
                        if (allChecked) inputToggleAll.checked = true;
                        else if (allUnchecked) inputToggleAll.checked = false;
                    }

                    dataWidget.value = JSON.stringify(data);
                    app.graph.setDirtyCanvas(true, false);
                };

                inputToggleAll.addEventListener("change", (e) => {
                    const state = e.target.checked;
                    const rowToggles = this.rowsContainer.querySelectorAll(".lora-toggle");
                    rowToggles.forEach(t => {
                        if(t.checked !== state) {
                            t.checked = state;
                            t.dispatchEvent(new Event("change")); 
                        }
                    });
                });

                async function fetchLoras() {
                    try {
                        const res = await fetch("/academia/lora_list");
                        loraList = await res.json();
                        const selects = container.querySelectorAll(".lora-select");
                        selects.forEach(select => {
                            const currentVal = select.value;
                            select.innerHTML = "";
                            loraList.forEach(l => {
                                const opt = document.createElement("option");
                                opt.value = l; opt.innerText = l;
                                select.appendChild(opt);
                            });
                            if(loraList.includes(currentVal)) select.value = currentVal;
                        });
                    } catch (e) {}
                }

                const ROW_HEIGHT = 30;

                const addRow = (data = {}) => {
                    const row = document.createElement("div");
                    row.className = "asd-lora-row";
                    
                    const isEnabled = data.enabled !== undefined ? data.enabled : true;
                    if(!isEnabled) row.classList.add("disabled");

                    const labelToggle = document.createElement("label");
                    labelToggle.className = "asd-switch";
                    const inputToggle = document.createElement("input");
                    inputToggle.type = "checkbox";
                    inputToggle.className = "lora-toggle";
                    inputToggle.checked = isEnabled;
                    const spanSlider = document.createElement("span");
                    spanSlider.className = "asd-slider";
                    labelToggle.appendChild(inputToggle);
                    labelToggle.appendChild(spanSlider);

                    const selectFile = document.createElement("select");
                    selectFile.className = "lora-select";
                    selectFile.style.cssText = "flex: 1; min-width: 0; padding: 2px; border: none; background: transparent; color: #ddd; outline: none; font-size: 12px; text-overflow: ellipsis; cursor: help;";
                    
                    if (loraList.length === 0 && data.name) {
                        const opt = document.createElement("option");
                        opt.value = data.name; opt.innerText = data.name;
                        selectFile.appendChild(opt);
                    } else {
                        loraList.forEach(l => {
                            const opt = document.createElement("option");
                            opt.value = l; opt.innerText = l;
                            selectFile.appendChild(opt);
                        });
                    }
                    if (data.name) selectFile.value = data.name;

                    // --- SISTEMA DE METADATOS AL PASAR EL RATÓN ---
                    let hoverTimeout;
                    selectFile.addEventListener("mouseenter", async (e) => {
                        const loraName = selectFile.value;
                        if (!loraName || loraName === "None") return;

                        // Pequeño retraso para que no parpadee si pasas el ratón rápido sin querer
                        hoverTimeout = setTimeout(async () => {
                            loraTooltip.style.display = "block";
                            loraTooltip.style.left = (e.clientX + 15) + "px";
                            loraTooltip.style.top = (e.clientY + 15) + "px";

                            if (loraMetadataCache[loraName]) {
                                loraTooltip.innerText = loraMetadataCache[loraName];
                                return;
                            }

                            loraTooltip.innerText = "⏳ Loading metadata...";
                            
                            try {
                                const res = await fetch("/academia/lora_info", {
                                    method: "POST", headers: {"Content-Type": "application/json"},
                                    body: JSON.stringify({name: loraName})
                                });
                                const jsonRes = await res.json();
                                loraMetadataCache[loraName] = jsonRes.info;
                                
                                // Si el ratón sigue encima, actualizamos el texto
                                if (loraTooltip.style.display === "block") {
                                    loraTooltip.innerText = jsonRes.info;
                                }
                            } catch(e) {
                                loraTooltip.innerText = "❌ Error loading metadata.";
                            }
                        }, 400); // 400ms de retraso
                    });

                    selectFile.addEventListener("mousemove", (e) => {
                        loraTooltip.style.left = (e.clientX + 15) + "px";
                        loraTooltip.style.top = (e.clientY + 15) + "px";
                    });

                    selectFile.addEventListener("mouseleave", () => {
                        clearTimeout(hoverTimeout);
                        loraTooltip.style.display = "none";
                    });
                    // ------------------------------------------------

                    const strengthContainer = document.createElement("div");
                    strengthContainer.style.cssText = "display: flex; align-items: center; background: rgba(0,0,0,0.4); border-radius: 4px; padding: 0 2px;";

                    const btnMinus = document.createElement("button");
                    btnMinus.innerText = "-";
                    btnMinus.className = "asd-step-btn";

                    const inputStrength = document.createElement("input");
                    inputStrength.type = "text";  
                    inputStrength.className = "lora-strength";
                    
                    let initialValue = parseFloat(data.strength !== undefined ? data.strength : 1.0);
                    if (isNaN(initialValue)) initialValue = 1.0;
                    inputStrength.value = initialValue.toFixed(2);
                    
                    inputStrength.style.cssText = "width: 40px; padding: 4px 0; border: none; background: transparent; color: white; outline: none; text-align: center; font-family: monospace; font-size: 13px; font-weight: bold;";

                    const btnPlus = document.createElement("button");
                    btnPlus.innerText = "+";
                    btnPlus.className = "asd-step-btn";

                    const adjustValue = (amount) => {
                        let val = parseFloat(inputStrength.value);
                        if (isNaN(val)) val = 0.0;
                        val += amount;
                        inputStrength.value = val.toFixed(2);
                        updateData();
                    };

                    btnMinus.addEventListener("click", () => adjustValue(-0.05));
                    btnPlus.addEventListener("click", () => adjustValue(0.05));

                    inputStrength.addEventListener("input", function() {
                        this.value = this.value.replace(/,/g, '.');
                        this.value = this.value.replace(/(?!^-)[^0-9.]/g, '');
                        if ((this.value.match(/\./g) || []).length > 1) {
                            this.value = this.value.slice(0, -1);
                        }
                    });

                    inputStrength.addEventListener("blur", function() {
                        let parsed = parseFloat(this.value);
                        if (isNaN(parsed)) parsed = 0.0;
                        this.value = parsed.toFixed(2);
                        updateData();
                    });

                    strengthContainer.appendChild(btnMinus);
                    strengthContainer.appendChild(inputStrength);
                    strengthContainer.appendChild(btnPlus);

                    const btnDelete = document.createElement("button");
                    btnDelete.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>`;
                    btnDelete.style.cssText = "background: transparent; border: none; color: #666; cursor: pointer; padding: 0 0 0 4px; display: flex; align-items: center; transition: color 0.2s;";
                    btnDelete.onmouseover = () => btnDelete.style.color = "#ff4444";
                    btnDelete.onmouseout = () => btnDelete.style.color = "#666";
                    
                    inputToggle.addEventListener("change", () => {
                        if(inputToggle.checked) row.classList.remove("disabled");
                        else row.classList.add("disabled");
                        updateData();
                    });
                    selectFile.addEventListener("change", updateData);
                    inputStrength.addEventListener("change", updateData);

                    btnDelete.addEventListener("click", () => {
                        row.remove();
                        this.size[1] -= ROW_HEIGHT;
                        updateData();
                    });

                    row.appendChild(labelToggle);
                    row.appendChild(selectFile);
                    row.appendChild(strengthContainer);
                    row.appendChild(btnDelete);
                    
                    this.rowsContainer.appendChild(row);
                    
                    this.size[1] += ROW_HEIGHT;
                    updateData();
                };

                btnAdd.addEventListener("click", () => {
                    addRow();
                });
                
                btnRefresh.addEventListener("click", () => fetchLoras());

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);
                
                fetchLoras().then(() => {
                    if (dataWidget && dataWidget.value) {
                        try {
                            const savedData = JSON.parse(dataWidget.value);
                            if (savedData.length > 0) {
                                savedData.forEach(l => addRow(l));
                            } else {
                                addRow(); 
                            }
                        } catch (e) { addRow(); }
                    } else {
                        addRow();
                    }
                });
            };
        }
    }
});
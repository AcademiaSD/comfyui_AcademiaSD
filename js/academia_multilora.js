import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.MultiLora",
    
    setup() {
        const originalRefresh = app.refreshComboInNodes;
        app.refreshComboInNodes = function() {
            let res;
            if (originalRefresh) res = originalRefresh.apply(this, arguments);
            if (app.graph) {
                for (let node of app.graph._nodes) {
                    if (node.type === "AcademiaSD_MultiLora" && typeof node.fetchLoras === "function") {
                        node.fetchLoras();
                    }
                }
            }
            return res;
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_MultiLora") {
            
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                const dataWidget = this.widgets.find(w => w.name === "lora_data");
                if (dataWidget && this.loraState) {
                    dataWidget.value = JSON.stringify(this.loraState);
                }
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                const dataWidget = this.widgets.find(w => w.name === "lora_data");
                if (dataWidget && dataWidget.value) {
                    try {
                        this.loraState = JSON.parse(dataWidget.value);
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

                const dataWidget = this.widgets.find(w => w.name === "lora_data");
                if (dataWidget) {
                    dataWidget.type = "hidden";
                    dataWidget.computeSize = () => [0, -4]; 
                    dataWidget.draw = function() {}; 
                }

                if (!this.loraState) {
                    this.loraState = [];
                }

                this.size = [420, 110];
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
                    
                    .asd-lora-row { display: flex; align-items: center; gap: 6px; background: rgba(0,0,0,0.3); border: 1px solid #444; border-radius: 6px; padding: 4px 6px; transition: opacity 0.2s; position: relative;}
                    .asd-lora-row.disabled { opacity: 0.5; }
                    
                    .asd-search-container { position: relative; flex: 1; min-width: 0; }
                    .asd-search-input { width: 100%; padding: 4px; border: 1px solid #555; background: #111; color: #ddd; border-radius: 4px; font-size: 12px; outline: none; box-sizing: border-box; cursor: text; text-overflow: ellipsis;}
                    .asd-search-input:focus { border-color: #4a6ee0; background: #1a1a1a; }
                    .asd-search-list { position: absolute; top: 100%; left: 0; right: 0; background: #222; border: 1px solid #555; border-radius: 4px; max-height: 200px; overflow-y: auto; z-index: 9999; display: none; box-shadow: 0 4px 10px rgba(0,0,0,0.6); margin-top: 2px;}
                    .asd-search-item { padding: 6px 8px; cursor: pointer; color: #ddd; font-size: 11px; word-break: break-all; border-bottom: 1px solid #333;}
                    .asd-search-item:last-child { border-bottom: none; }
                    .asd-search-item:hover { background: #4a6ee0; color: #fff; }
                    .asd-search-item.missing { color: #ff4444; font-weight: bold; }

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
                this.rowsContainer.style.gap = "4px"; 
                container.appendChild(this.rowsContainer);

                const btnAdd = document.createElement("button");
                btnAdd.innerText = "➕ Add Lora";
                btnAdd.style.cssText = "cursor: pointer; padding: 4px; background: rgba(255,255,255,0.05); color: #aaa; border: 1px solid #444; border-radius: 6px; font-weight: bold; margin-top: 2px; font-size: 11px; transition: background 0.2s;";
                btnAdd.onmouseover = () => btnAdd.style.background = "rgba(255,255,255,0.1)";
                btnAdd.onmouseout = () => btnAdd.style.background = "rgba(255,255,255,0.05)";
                container.appendChild(btnAdd);

                const HTML_BASE_HEIGHT = 140; 
                const ROW_HEIGHT = 38; 
                const MIN_WIDTH = 420;

                this.computeSize = function(out) {
                    const numRows = _this.loraState ? _this.loraState.length : 0;
                    const computedHeight = HTML_BASE_HEIGHT + (numRows * ROW_HEIGHT);
                    return [MIN_WIDTH, computedHeight];
                };

                const originalOnResize = this.onResize;
                this.onResize = function(size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    const minSize = this.computeSize();
                    if (size[1] < minSize[1]) size[1] = minSize[1];
                    if (size[0] < minSize[0]) size[0] = minSize[0];
                };

                const forceResize = () => {
                    const minSize = _this.computeSize();
                    _this.setSize([Math.max(_this.size[0], MIN_WIDTH), minSize[1]]);
                    app.graph.setDirtyCanvas(true, true);
                };

                // --- NUEVA ARQUITECTURA DE DATOS REACTIVA ---
                const syncWidget = () => {
                    if (dataWidget) dataWidget.value = JSON.stringify(_this.loraState);
                    app.graph.setDirtyCanvas(true, false);
                };

                const checkToggleAll = () => {
                    if (_this.loraState.length === 0) return;
                    let allChecked = true;
                    let allUnchecked = true;
                    _this.loraState.forEach(l => {
                        if (l.enabled) allUnchecked = false;
                        else allChecked = false;
                    });
                    if (allChecked) inputToggleAll.checked = true;
                    else if (allUnchecked) inputToggleAll.checked = false;
                };

                inputToggleAll.addEventListener("change", (e) => {
                    const state = e.target.checked;
                    _this.loraState.forEach(l => l.enabled = state);
                    syncWidget();
                    _this.renderUI();
                });

                this.fetchLoras = async function() {
                    try {
                        const res = await fetch("/academia/lora_list");
                        loraList = await res.json();
                        _this.renderUI();
                    } catch (e) {}
                };

                let hoverTimeout;
                const handleTooltipEnter = (e, loraName) => {
                    if (!loraName || loraName === "None" || loraName.includes("(Missing)")) return;
                    
                    hoverTimeout = setTimeout(async () => {
                        let loraTooltip = document.getElementById("asd-lora-tooltip");
                        if (!loraTooltip) return;

                        loraTooltip.style.display = "block";
                        loraTooltip.style.left = (e.clientX + 15) + "px";
                        loraTooltip.style.top = (e.clientY + 15) + "px";

                        if (window.loraMetadataCache && window.loraMetadataCache[loraName]) {
                            loraTooltip.innerText = window.loraMetadataCache[loraName];
                            return;
                        }

                        loraTooltip.innerText = "⏳ Loading metadata...";
                        try {
                            const res = await fetch("/academia/lora_info", {
                                method: "POST", headers: {"Content-Type": "application/json"},
                                body: JSON.stringify({name: loraName})
                            });
                            const jsonRes = await res.json();
                            if(!window.loraMetadataCache) window.loraMetadataCache = {};
                            window.loraMetadataCache[loraName] = jsonRes.info;
                            
                            if (loraTooltip.style.display === "block") {
                                loraTooltip.innerText = jsonRes.info;
                            }
                        } catch(e) {
                            loraTooltip.innerText = "❌ Error loading metadata.";
                        }
                    }, 400); 
                };

                const handleTooltipMove = (e) => {
                    let loraTooltip = document.getElementById("asd-lora-tooltip");
                    if(loraTooltip) {
                        loraTooltip.style.left = (e.clientX + 15) + "px";
                        loraTooltip.style.top = (e.clientY + 15) + "px";
                    }
                };

                const handleTooltipLeave = () => {
                    clearTimeout(hoverTimeout);
                    let loraTooltip = document.getElementById("asd-lora-tooltip");
                    if(loraTooltip) loraTooltip.style.display = "none";
                };

                this.renderUI = () => {
                    _this.rowsContainer.innerHTML = "";

                    _this.loraState.forEach((item, idx) => {
                        const row = document.createElement("div");
                        row.className = "asd-lora-row";
                        row.style.zIndex = 1000 - idx; 
                        
                        const isEnabled = item.enabled !== undefined ? item.enabled : true;
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

                        const searchContainer = document.createElement("div");
                        searchContainer.className = "asd-search-container";

                        const inputSearch = document.createElement("input");
                        inputSearch.type = "text";
                        inputSearch.className = "asd-search-input";
                        inputSearch.placeholder = "Type to search LoRA...";
                        inputSearch.value = item.name || "";

                        const dropdownList = document.createElement("div");
                        dropdownList.className = "asd-search-list";

                        const populateDropdown = (filterText) => {
                            dropdownList.innerHTML = "";
                            const lowerFilter = filterText.toLowerCase();
                            let matchCount = 0;

                            const currentVal = inputSearch.value;
                            if (currentVal && !loraList.includes(currentVal) && currentVal !== "None") {
                                const opt = document.createElement("div");
                                opt.className = "asd-search-item missing";
                                opt.innerText = currentVal + " (Missing/Pending)";
                                opt.addEventListener("mousedown", () => {
                                    inputSearch.value = currentVal;
                                    dropdownList.style.display = "none";
                                    _this.loraState[idx].name = currentVal;
                                    syncWidget();
                                });
                                dropdownList.appendChild(opt);
                            }

                            loraList.forEach(loraName => {
                                if (loraName.toLowerCase().includes(lowerFilter)) {
                                    const opt = document.createElement("div");
                                    opt.className = "asd-search-item";
                                    opt.innerText = loraName;
                                    
                                    opt.addEventListener("mouseenter", (e) => handleTooltipEnter(e, loraName));
                                    opt.addEventListener("mousemove", handleTooltipMove);
                                    opt.addEventListener("mouseleave", handleTooltipLeave);

                                    opt.addEventListener("mousedown", () => {
                                        inputSearch.value = loraName;
                                        dropdownList.style.display = "none";
                                        _this.loraState[idx].name = loraName;
                                        syncWidget();
                                    });
                                    dropdownList.appendChild(opt);
                                    matchCount++;
                                }
                            });

                            if (matchCount === 0) {
                                const noRes = document.createElement("div");
                                noRes.style.cssText = "padding: 6px 8px; color: #777; font-size: 11px; text-align: center;";
                                noRes.innerText = "No matches found";
                                dropdownList.appendChild(noRes);
                            }
                        };

                        inputSearch.addEventListener("focus", () => {
                            populateDropdown(""); 
                            dropdownList.style.display = "block";
                            row.style.zIndex = 2000; 
                        });

                        inputSearch.addEventListener("input", (e) => {
                            populateDropdown(e.target.value);
                            dropdownList.style.display = "block";
                            _this.loraState[idx].name = e.target.value;
                            syncWidget();
                        });

                        inputSearch.addEventListener("blur", () => {
                            row.style.zIndex = 1000 - idx;
                            setTimeout(() => { dropdownList.style.display = "none"; }, 150);
                        });

                        inputSearch.addEventListener("mouseenter", (e) => {
                            if(dropdownList.style.display !== "block") handleTooltipEnter(e, inputSearch.value);
                        });
                        inputSearch.addEventListener("mousemove", handleTooltipMove);
                        inputSearch.addEventListener("mouseleave", handleTooltipLeave);

                        searchContainer.appendChild(inputSearch);
                        searchContainer.appendChild(dropdownList);

                        const strengthContainer = document.createElement("div");
                        strengthContainer.style.cssText = "display: flex; align-items: center; background: rgba(0,0,0,0.4); border-radius: 4px; padding: 0 2px;";

                        const btnMinus = document.createElement("button");
                        btnMinus.innerText = "-";
                        btnMinus.className = "asd-step-btn";

                        const inputStrength = document.createElement("input");
                        inputStrength.type = "text";  
                        inputStrength.className = "lora-strength";
                        
                        let initialValue = parseFloat(item.strength !== undefined ? item.strength : 1.0);
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
                            _this.loraState[idx].strength = val;
                            syncWidget();
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
                            _this.loraState[idx].strength = parsed;
                            syncWidget();
                        });

                        strengthContainer.appendChild(btnMinus);
                        strengthContainer.appendChild(inputStrength);
                        strengthContainer.appendChild(btnPlus);

                        const btnDelete = document.createElement("button");
                        btnDelete.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>`;
                        btnDelete.style.cssText = "background: transparent; border: none; color: #666; cursor: pointer; padding: 0 0 0 4px; display: flex; align-items: center; transition: color 0.2s;";
                        btnDelete.onmouseover = () => btnDelete.style.color = "#ff4444";
                        btnDelete.onmouseout = () => btnDelete.style.color = "#666";
                        
                        inputToggle.addEventListener("change", (e) => {
                            _this.loraState[idx].enabled = e.target.checked;
                            if(e.target.checked) row.classList.remove("disabled");
                            else row.classList.add("disabled");
                            syncWidget();
                            checkToggleAll();
                        });
                        
                        btnDelete.addEventListener("click", () => {
                            _this.loraState.splice(idx, 1);
                            syncWidget();
                            _this.renderUI();
                        });

                        row.appendChild(labelToggle);
                        row.appendChild(searchContainer);
                        row.appendChild(strengthContainer);
                        row.appendChild(btnDelete);
                        
                        _this.rowsContainer.appendChild(row);
                    });

                    checkToggleAll();
                    forceResize();
                }; 

                btnAdd.addEventListener("click", () => {
                    const defaultName = loraList.length > 0 ? loraList[0] : "";
                    _this.loraState.push({ enabled: true, name: defaultName, strength: 1.0 });
                    syncWidget();
                    _this.renderUI();
                });
                
                btnRefresh.addEventListener("click", () => _this.fetchLoras());

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);
                
                if(!window.loraMetadataCache) window.loraMetadataCache = {};
                let globalTooltip = document.getElementById("asd-lora-tooltip");
                if (!globalTooltip) {
                    globalTooltip = document.createElement("div");
                    globalTooltip.id = "asd-lora-tooltip";
                    globalTooltip.style.cssText = `
                        position: fixed; background: rgba(20, 20, 20, 0.95); color: #fff; 
                        border: 1px solid #555; padding: 10px; border-radius: 6px; 
                        z-index: 999999; display: none; pointer-events: none; 
                        font-family: monospace; font-size: 13px; line-height: 1.4;
                        white-space: pre-wrap; max-width: 400px; box-shadow: 0 4px 10px rgba(0,0,0,0.6);
                        backdrop-filter: blur(4px);
                    `;
                    document.body.appendChild(globalTooltip);
                }

                // INICIALIZACIÓN
                this.fetchLoras().then(() => {
                    if (dataWidget && dataWidget.value) {
                        try {
                            const savedData = JSON.parse(dataWidget.value);
                            if (savedData.length > 0) {
                                _this.loraState = savedData;
                            }
                        } catch (e) {}
                    }
                    _this.renderUI();
                });
            };
        }
    }
});
import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.Noise",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_Noise") {
            
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                if (o.properties && o.properties.seed_history) {
                    this.properties.seed_history = o.properties.seed_history;
                }
                this.hideWidgets();
                this.cleanOutputs();
                this.cleanInputs();
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const MIN_WIDTH = 230; 
                this.size = [230, 78]; // Ajustado al tamaño base inicial correcto
                const _this = this;

                if (!this.properties) this.properties = {};
                if (!this.properties.seed_history) this.properties.seed_history = [];
                
                let historyIndex = 0;

                // --- SISTEMA DE CONTROL DE INTERFAZ FORZADO ---
                
                // Ocultamos los widgets y re-inyectamos dinámicamente serializeValue para evitar que se pierda
                this.hideWidgets = function() {
                    if (_this.widgets) {
                        _this.widgets.forEach(w => {
                            if (w.name === "seed_val") {
                                w.type = "hidden";
                                w.draw = () => {};
                                w.computeSize = () => [0, 0];
                                
                                // Inyección dinámica para asegurar persistencia tras cargas de workflow
                                w.serializeValue = function() {
                                    const activeModeWidget = _this.widgets.find(widget => widget.name === "mode");
                                    if (!activeModeWidget) return w.value;
                                    
                                    const mode = activeModeWidget.value;
                                    const currentSeed = w.value;
                                    let activeSeed = currentSeed;

                                    _this.properties.seed_history = _this.properties.seed_history || [];

                                    if (mode !== "fixed") {
                                        if (mode === "randomize") {
                                            activeSeed = generateRandomSeed();
                                        } else if (mode === "increment") {
                                            activeSeed = (currentSeed + 1) % 9007199254740991;
                                        } else if (mode === "decrement") {
                                            activeSeed = (currentSeed - 1 + 9007199254740991) % 9007199254740991;
                                        }

                                        w.value = activeSeed;
                                        const seedInput = container.querySelector(".asn-input");
                                        if (seedInput) seedInput.value = activeSeed;
                                    }

                                    addToHistory(activeSeed);

                                    historyIndex = 0;
                                    updateHistoryUI();
                                    forceResize();
                                    
                                    return activeSeed;
                                };
                            }
                            if (w.name === "mode" || w.name === "control_after_generate") {
                                w.type = "hidden";
                                w.draw = () => {};
                                w.computeSize = () => [0, 0];
                            }
                        });
                    }
                };

                this.cleanOutputs = function() {
                    if (_this.outputs && _this.outputs.length > 1) {
                        while (_this.outputs.length > 1) {
                            _this.removeOutput(1); 
                        }
                    }
                };

                this.cleanInputs = function() {
                    if (_this.inputs && _this.inputs.length > 0) {
                        while (_this.inputs.length > 0) {
                            _this.removeInput(0);
                        }
                    }
                };

                const originalDrawForeground = this.onDrawForeground;
                this.onDrawForeground = function(ctx) {
                    _this.hideWidgets();
                    _this.cleanOutputs();
                    _this.cleanInputs();
                    if (originalDrawForeground) originalDrawForeground.apply(this, arguments);
                };

                const container = document.createElement("div");
                container.style.cssText = `
                    padding: 3px; background: #222; border-radius: 4px;
                    font-family: sans-serif; font-size: 10px; display: flex;
                    flex-direction: column; gap: 3px; width: 100%; height: 100%;
                    box-sizing: border-box; color: #fff; margin-top: -16px;
                `;

                container.innerHTML = `
                    <style>
                        .asn-btn {
                            cursor: pointer; padding: 1px 3px; color: #ddd;
                            border: 1px solid #444; border-radius: 2px;
                            font-size: 9px; background: #2a2a2a; font-weight: bold;
                            transition: background 0.1s, border-color 0.1s;
                        }
                        .asn-btn:hover { background: #3a3a3a; border-color: #666; }
                        .asn-input {
                            padding: 1px 3px; background: #111; color: #fff;
                            border: 1px solid #444; border-radius: 2px;
                            font-size: 10px; font-family: monospace; outline: none;
                            flex: 1; min-width: 0;
                        }
                    </style>
                    <div style="display: flex; gap: 4px; align-items: center;">
                        <span style="font-weight: bold; color: #aaa; font-size: 9px;">Seed:</span>
                        <input type="number" class="asn-input" value="0">
                    </div>
                    <div style="display: flex; gap: 2px;">
                        <button class="asn-btn asn-mode-fixed" style="flex: 1;">🔒 Fix</button>
                        <button class="asn-btn asn-mode-random" style="flex: 1;">🎲 Rand</button>
                        <button class="asn-btn asn-mode-inc" style="flex: 0.5;" title="Increment">+ </button>
                        <button class="asn-btn asn-mode-dec" style="flex: 0.5;" title="Decrement">- </button>
                    </div>
                    <div style="display: flex; gap: 2px;">
                        <button class="asn-btn asn-action-gen" style="flex: 1.1; background: #1a5c2b; border-color: #2d9444; color: #fff;">Roll</button>
                        <button class="asn-btn asn-action-recover" style="flex: 1.9;">Undo (0)</button>
                        <button class="asn-btn asn-action-copy" style="flex: 1;">Copy</button>
                    </div>
                    <div class="asn-history-panel" style="display: none; background: #111; border-radius: 2px; padding: 2px; max-height: 75px; overflow-y: auto; flex-direction: column; gap: 2px; border: 1px solid #333; margin-top: 2px;">
                    </div>
                `;

                const seedInput = container.querySelector(".asn-input");
                const btnFixed = container.querySelector(".asn-mode-fixed");
                const btnRandom = container.querySelector(".asn-mode-random");
                const btnInc = container.querySelector(".asn-mode-inc");
                const btnDec = container.querySelector(".asn-mode-dec");
                const rollBtn = container.querySelector(".asn-action-gen");
                const recoverBtn = container.querySelector(".asn-action-recover");
                const copyBtn = container.querySelector(".asn-action-copy");
                const historyPanel = container.querySelector(".asn-history-panel");

                this.computeSize = function(out) {
                    let baseH = 78; // Corregido definitivamente de 58 a 78 para albergar los botones base
                    let historyLength = (this.properties.seed_history || []).length;
                    let historyHeight = historyLength > 0 ? Math.min(historyLength * 16 + 6, 75) : 0;
                    return [MIN_WIDTH, baseH + historyHeight];
                };

                const forceResize = () => {
                    setTimeout(() => {
                        const min = this.computeSize();
                        this.setSize([Math.max(this.size[0], min[0]), min[1]]);
                        app.graph.setDirtyCanvas(true, true);
                    }, 10);
                };

                const originalOnResize = this.onResize;
                this.onResize = function(size) {
                    if (originalOnResize) originalOnResize.apply(this, arguments);
                    const min = this.computeSize();
                    if (size[0] < MIN_WIDTH) size[0] = MIN_WIDTH;
                    size[1] = min[1]; 
                };

                const generateRandomSeed = () => {
                    return Math.floor(Math.random() * 9007199254740991);
                };

                const addToHistory = (seed) => {
                    if (!_this.properties.seed_history) _this.properties.seed_history = [];
                    
                    const s = parseInt(seed);
                    if (isNaN(s)) return;

                    const existingIndex = _this.properties.seed_history.indexOf(s);
                    if (existingIndex !== -1) {
                        _this.properties.seed_history.splice(existingIndex, 1);
                    }

                    _this.properties.seed_history.unshift(s);

                    if (_this.properties.seed_history.length > 10) {
                        _this.properties.seed_history.pop();
                    }
                };

                const updateHistoryUI = () => {
                    const history = _this.properties.seed_history || [];
                    recoverBtn.innerText = `Undo (${history.length})`;
                    historyPanel.innerHTML = "";

                    if (history.length > 0) {
                        historyPanel.style.display = "flex";
                        history.forEach((s, idx) => {
                            const item = document.createElement("div");
                            item.style.cssText = `
                                display: flex; justify-content: space-between; align-items: center;
                                padding: 1px 3px; background: #1a1a1a; border-radius: 2px;
                                font-size: 8px; cursor: pointer; border: 1px solid #2a2a2a; transition: 0.1s;
                            `;
                            item.innerHTML = `
                                <span style="color: #aaa; font-family: monospace;">#${idx + 1}: ${s}</span>
                                <span style="color: #4a6ee0; font-weight: bold; font-size: 8px;">Load</span>
                            `;
                            item.addEventListener("click", () => {
                                const seedValWidget = _this.widgets.find(w => w.name === "seed_val");
                                const modeValWidget = _this.widgets.find(w => w.name === "mode");
                                if (seedValWidget) {
                                    addToHistory(seedValWidget.value);
                                    seedValWidget.value = s;
                                    seedInput.value = s;
                                }
                                if (modeValWidget) {
                                    modeValWidget.value = "fixed";
                                    updateModeButtons("fixed");
                                }
                                historyIndex = (idx + 1) % history.length;
                                updateHistoryUI();
                                forceResize();
                            });
                            item.addEventListener("mouseenter", () => item.style.background = "#252525");
                            item.addEventListener("mouseleave", () => item.style.background = "#1a1a1a");
                            historyPanel.appendChild(item);
                        });
                    } else {
                        historyPanel.style.display = "none";
                    }
                };

                const updateModeButtons = (activeMode) => {
                    [btnFixed, btnRandom, btnInc, btnDec].forEach(b => {
                        b.style.background = "#2a2a2a";
                        b.style.borderColor = "#444";
                    });

                    if (activeMode === "fixed") {
                        btnFixed.style.background = "#4a6ee0";
                        btnFixed.style.borderColor = "#4a6ee0";
                    } else if (activeMode === "randomize") {
                        btnRandom.style.background = "#4a6ee0";
                        btnRandom.style.borderColor = "#4a6ee0";
                    } else if (activeMode === "increment") {
                        btnInc.style.background = "#4a6ee0";
                        btnInc.style.borderColor = "#4a6ee0";
                    } else if (activeMode === "decrement") {
                        btnDec.style.background = "#4a6ee0";
                        btnDec.style.borderColor = "#4a6ee0";
                    }
                };

                btnFixed.addEventListener("click", () => {
                    const modeValWidget = _this.widgets.find(w => w.name === "mode");
                    if (modeValWidget) { modeValWidget.value = "fixed"; updateModeButtons("fixed"); }
                });
                btnRandom.addEventListener("click", () => {
                    const modeValWidget = _this.widgets.find(w => w.name === "mode");
                    if (modeValWidget) { modeValWidget.value = "randomize"; updateModeButtons("randomize"); }
                });
                btnInc.addEventListener("click", () => {
                    const modeValWidget = _this.widgets.find(w => w.name === "mode");
                    if (modeValWidget) { modeValWidget.value = "increment"; updateModeButtons("increment"); }
                });
                btnDec.addEventListener("click", () => {
                    const modeValWidget = _this.widgets.find(w => w.name === "mode");
                    if (modeValWidget) { modeValWidget.value = "decrement"; updateModeButtons("decrement"); }
                });

                seedInput.addEventListener("change", (e) => {
                    let val = parseInt(e.target.value);
                    if (isNaN(val) || val < 0) val = 0;
                    if (val > 9007199254740991) val = 9007199254740991;
                    
                    const seedValWidget = _this.widgets.find(w => w.name === "seed_val");
                    if (seedValWidget && seedValWidget.value !== val) {
                        addToHistory(seedValWidget.value);
                        seedValWidget.value = val;
                        seedInput.value = val;
                        historyIndex = 0;
                        updateHistoryUI();
                        forceResize();
                    }
                });

                rollBtn.addEventListener("click", () => {
                    const seedValWidget = _this.widgets.find(w => w.name === "seed_val");
                    const modeValWidget = _this.widgets.find(w => w.name === "mode");
                    if (seedValWidget) {
                        addToHistory(seedValWidget.value);
                        const newSeed = generateRandomSeed();
                        seedValWidget.value = newSeed;
                        seedInput.value = newSeed;
                        if (modeValWidget) {
                            modeValWidget.value = "fixed";
                            updateModeButtons("fixed");
                        }
                        historyIndex = 0;
                        updateHistoryUI();
                        forceResize();
                    }
                });

                recoverBtn.addEventListener("click", () => {
                    const history = _this.properties.seed_history || [];
                    if (history.length === 0) return;

                    const restoredSeed = history[historyIndex];
                    const seedValWidget = _this.widgets.find(w => w.name === "seed_val");
                    const modeValWidget = _this.widgets.find(w => w.name === "mode");

                    if (seedValWidget) {
                        seedValWidget.value = restoredSeed;
                        seedInput.value = restoredSeed;
                    }
                    if (modeValWidget) {
                        modeValWidget.value = "fixed";
                        updateModeButtons("fixed");
                    }

                    historyIndex = (historyIndex + 1) % history.length;
                    recoverBtn.innerText = `Undo (${history.length})`;
                });

                copyBtn.addEventListener("click", () => {
                    navigator.clipboard.writeText(seedInput.value).then(() => {
                        const origText = copyBtn.innerText;
                        copyBtn.innerText = "Copied!";
                        copyBtn.style.background = "#2d5a27";
                        copyBtn.style.borderColor = "#2d5a27";
                        setTimeout(() => {
                            copyBtn.innerText = origText;
                            copyBtn.style.background = "#2a2a2a";
                            copyBtn.style.borderColor = "#444";
                        }, 1000);
                    }).catch(()=>{});
                });

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                const domWidget = this.addDOMWidget("UI", "HTML", container);
                
                domWidget.computeSize = function() {
                    return [_this.size[0], _this.size[1] - 14];
                };

                this.hideWidgets();
                this.cleanOutputs();
                this.cleanInputs();

                setTimeout(() => {
                    _this.hideWidgets();
                    _this.cleanOutputs();
                    _this.cleanInputs();
                    const seedValWidget = _this.widgets.find(w => w.name === "seed_val");
                    const modeValWidget = _this.widgets.find(w => w.name === "mode");
                    if (seedValWidget) seedInput.value = seedValWidget.value;
                    if (modeValWidget) updateModeButtons(modeValWidget.value);
                    updateHistoryUI();
                    forceResize();
                }, 100);
            };
        }
    }
});
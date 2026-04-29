import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "AcademiaSD.MultiPrompt",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "AcademiaSD_MultiPrompt") {
            
            const onSerialize = nodeType.prototype.onSerialize;
            nodeType.prototype.onSerialize = function(o) {
                if (onSerialize) onSerialize.apply(this, arguments);
                const dataWidget = this.widgets.find(w => w.name === "prompt_data");
                if (dataWidget && this.promptState) {
                    dataWidget.value = JSON.stringify(this.promptState);
                }
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function(o) {
                if (onConfigure) onConfigure.apply(this, arguments);
                const dataWidget = this.widgets.find(w => w.name === "prompt_data");
                if (dataWidget && dataWidget.value) {
                    try {
                        this.promptState = JSON.parse(dataWidget.value);
                    } catch (e) {}
                }
                if (this.renderUI) this.renderUI();
            };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const _this = this;
                const defaultText = "[VISUAL]:\n[SPEECH]:\n[SOUNDS]:";

                if (!this.promptState) {
                    this.promptState = [{ text: defaultText }];
                }

                const dataWidget = this.widgets.find(w => w.name === "prompt_data");
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

                const style = document.createElement("style");
                style.innerHTML = `
                    .asd-pm-box { background: #222; border: 1px solid #444; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 6px;}
                    .asd-pm-header { display: flex; justify-content: space-between; align-items: center; color: #ccc; font-size: 12px; font-weight: bold;}
                    .asd-pm-textarea { width: 100%; min-height: 80px; padding: 8px; box-sizing: border-box; border: 1px solid #555; border-radius: 4px; background: #111; color: white; outline: none; resize: vertical; font-family: monospace; font-size: 13px;}
                    .asd-pm-textarea:focus { border-color: #4a6ee0; }
                    .asd-del-btn { background: transparent; border: none; color: #888; cursor: pointer; transition: 0.2s; font-size: 12px;}
                    .asd-del-btn:hover { color: #ff4444; }
                `;
                container.appendChild(style);

                this.rowsContainer = document.createElement("div");
                this.rowsContainer.style.display = "flex";
                this.rowsContainer.style.flexDirection = "column";
                this.rowsContainer.style.gap = "8px";
                container.appendChild(this.rowsContainer);

                const btnAdd = document.createElement("button");
                btnAdd.innerText = "➕ Add Prompt Keyframe";
                btnAdd.style.cssText = "cursor: pointer; padding: 10px; background: #225588; color: white; border: none; border-radius: 4px; font-weight: bold; font-size: 12px; margin-top: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.3); transition: background 0.2s;";
                btnAdd.onmouseover = () => btnAdd.style.background = "#2b6cb0";
                btnAdd.onmouseout = () => btnAdd.style.background = "#225588";
                container.appendChild(btnAdd);

                const MIN_WIDTH = 440;

                this.computeSize = function(out) {
                    let numInputs = this.inputs ? this.inputs.length : 0;
                    let baseH = 60 + (numInputs * 22);
                    let htmlH = 85; 
                    
                    if (_this.rowsContainer && _this.rowsContainer.children.length > 0) {
                        for(let row of _this.rowsContainer.children) {
                            htmlH += row.offsetHeight + 8; 
                        }
                    } else {
                        let N = _this.promptState ? _this.promptState.length : 0;
                        htmlH += (N * 140); 
                    }

                    // CORRECCIÓN: Devolvemos MIN_WIDTH para que puedas encoger la caja
                    return [MIN_WIDTH, baseH + htmlH];
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
                    if (dataWidget) dataWidget.value = JSON.stringify(_this.promptState);
                    app.graph.setDirtyCanvas(true, false);
                };

                this.renderUI = () => {
                    _this.rowsContainer.innerHTML = "";

                    _this.promptState.forEach((item, idx) => {
                        const box = document.createElement("div");
                        box.className = "asd-pm-box";
                        
                        const header = document.createElement("div");
                        header.className = "asd-pm-header";
                        
                        const title = document.createElement("span");
                        title.innerText = `🎬 Prompt ${idx + 1}`;
                        header.appendChild(title);
                        
                        if (idx > 0) {
                            const btnDelete = document.createElement("button");
                            btnDelete.className = "asd-del-btn";
                            btnDelete.innerText = "❌";
                            btnDelete.addEventListener("click", () => {
                                _this.promptState.splice(idx, 1);
                                updateData();
                                _this.renderUI();
                            });
                            header.appendChild(btnDelete);
                        } else {
                            const ghost = document.createElement("div");
                            ghost.style.width = "16px";
                            header.appendChild(ghost);
                        }
                        
                        box.appendChild(header);

                        const textarea = document.createElement("textarea");
                        textarea.className = "asd-pm-textarea";
                        textarea.value = item.text;

                        textarea.addEventListener("input", function() {
                            _this.promptState[idx].text = this.value;
                            updateData();
                        });

                        textarea.addEventListener("mouseup", forceResize);

                        box.appendChild(textarea);
                        _this.rowsContainer.appendChild(box);
                    });

                    forceResize();
                };

                btnAdd.addEventListener("click", () => {
                    let newText = defaultText;
                    if (_this.promptState.length > 0) {
                        const lastText = _this.promptState[_this.promptState.length - 1].text.trim();
                        if (lastText !== "") {
                            newText = lastText;
                        }
                    }
                    _this.promptState.push({ text: newText });
                    updateData();
                    _this.renderUI();
                });

                container.addEventListener("mousedown", (e) => e.stopPropagation());
                this.addDOMWidget("UI", "HTML", container);

                setTimeout(() => {
                    if (dataWidget && dataWidget.value && dataWidget.value !== "[]" && dataWidget.value !== "") {
                        try {
                            _this.promptState = JSON.parse(dataWidget.value);
                        } catch (e) {}
                    }
                    _this.renderUI();
                }, 100);
            };
        }
    }
});
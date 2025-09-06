// comfyui_AcademiaSD/web/static/custom_nodes/integer_bypasser.js
import { app } from "../../scripts/app.js";

// --- DEFINICIÓN DE MODOS ---
const MODE_ALWAYS = LiteGraph.ALWAYS; // 0
const MODE_BYPASS = 4;

function safeInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function getUpstreamNode(node, inputIndex) {
  try {
    if (!node.inputs || inputIndex >= node.inputs.length) return null;
    const input = node.inputs[inputIndex];
    if (!input || input.link == null) return null;
    const link = app.graph.links[input.link];
    if (!link) return null;
    const originId = link.origin_id;
    return app.graph._nodes_by_id[originId] || null;
  } catch (e) {
    console.error("IntegerBypasser: getUpstreamNode error", e);
    return null;
  }
}

function setNodeMode(targetNode, enabled) {
  try {
    if (!targetNode) return;
    const newMode = enabled ? MODE_ALWAYS : MODE_BYPASS;
    if (targetNode.mode === newMode) return;
    targetNode.mode = newMode;
    // Forzamos el redraw del canvas (suele ser suficiente)
    if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, false);
    console.log(`IntegerBypasser: Node ${targetNode.id} mode set to ${enabled ? 'ALWAYS' : 'BYPASS'} (${newMode})`);
  } catch (e) {
    console.error("IntegerBypasser: setNodeMode error", e);
  }
}

/* --- Helpers para inputs / toggles --- */

function getControlSlots(node) {
  const slots = [];
  if (!node.inputs) return slots;
  for (let i = 0; i < node.inputs.length; i++) {
    const input = node.inputs[i];
    if (!input) continue;
    if (input.name === "active_count") continue;
    slots.push(i);
  }
  return slots;
}

function getNextInName(node) {
  const used = new Set();
  for (const inp of node.inputs || []) {
    if (!inp || !inp.name) continue;
    const m = inp.name.match(/^in(\d+)$/i);
    if (m) used.add(parseInt(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `in${n}`;
}

function ensureToggleForSlot(node, toggleIndex, slotIndex) {
  const desiredName = `bypass_toggle_${toggleIndex}`;

  let widget = node.widgets.find(w => w.name === desiredName);

  if (!widget) {
    widget = node.widgets.find(w => w.slotIndex === slotIndex);
  }

  if (!widget) {
    widget = node.widgets.find(w => {
      if (!w.name) return false;
      if (!w.name.startsWith("bypass_toggle_")) return false;
      const num = parseInt(w.name.split("_").pop());
      return num === slotIndex;
    });
  }

  if (!widget) {
    widget = node.addWidget("toggle", desiredName, false, (v) => {
      onToggleChanged(node, toggleIndex, v);
    }, { on: "ON", off: "BYPASS" });
  } else {
    widget.callback = (v) => onToggleChanged(node, toggleIndex, v);
    if (widget.name !== desiredName) widget.name = desiredName;
  }

  widget.slotIndex = slotIndex;

  const upstream = getUpstreamNode(node, slotIndex);
  widget.label = upstream ? (upstream.title || upstream.type || `Node ${upstream.id}`) : `Enable ${toggleIndex + 1}`;
  widget.value = !!(upstream && upstream.mode === MODE_ALWAYS);

  return widget;
}

/* --- Lógica de toggles / conteo --- */

function onToggleChanged(node, toggleIndex, value) {
  try {
    const widgetName = `bypass_toggle_${toggleIndex}`;
    const widget = node.widgets.find(w => w.name === widgetName);
    if (!widget) {
      console.warn(`IntegerBypasser: onToggleChanged - widget ${widgetName} not found`);
      return;
    }

    let slotIndex = widget.slotIndex;
    if (slotIndex == null) {
      const controlSlots = getControlSlots(node);
      slotIndex = controlSlots[toggleIndex];
      if (slotIndex == null) {
        console.warn(`IntegerBypasser: onToggleChanged - cannot map toggle ${toggleIndex} to slot`);
        return;
      }
      widget.slotIndex = slotIndex;
    }

    const upstream = getUpstreamNode(node, slotIndex);
    if (upstream) {
      setNodeMode(upstream, !!value);
    } else {
      widget.value = !!value;
    }
    updateActiveCount(node);
  } catch (e) {
    console.error("IntegerBypasser: onToggleChanged error", e);
  }
}

function updateActiveCount(node) {
  try {
    const toggles = node.widgets
      .filter(w => w.name?.startsWith("bypass_toggle_"))
      .sort((a, b) => {
        const na = parseInt(a.name.split("_").pop());
        const nb = parseInt(b.name.split("_").pop());
        return na - nb;
      });

    let count = 0;
    for (const toggle of toggles) {
      if (toggle.value) count++;
      else break;
    }

    const activeCountWidget = node.widgets.find(w => w.name === "active_count");
    if (activeCountWidget && activeCountWidget.value !== count) {
      activeCountWidget.value = count;
    }
  } catch (e) {
    console.error("IntegerBypasser: updateActiveCount error", e);
  }
}

function applyActiveCount(node, count) {
  try {
    const toggles = node.widgets
      .filter(w => w.name?.startsWith("bypass_toggle_"))
      .sort((a, b) => {
        const na = parseInt(a.name.split("_").pop());
        const nb = parseInt(b.name.split("_").pop());
        return na - nb;
      });

    const clamped = Math.max(0, Math.min(count, toggles.length));

    for (let i = 0; i < toggles.length; i++) {
      const shouldBeActive = i < clamped;
      if (toggles[i].value !== shouldBeActive) {
        toggles[i].value = shouldBeActive;
        onToggleChanged(node, i, shouldBeActive);
      }
    }
  } catch (e) {
    console.error("IntegerBypasser: applyActiveCount error", e);
  }
}

/* --- Refresco de inputs y sincronización --- */

function refreshInputsAndToggles(node) {
  try {
    if (!node.inputs || node.inputs.length === 0) {
      node.addInput("in1", "LATENT");
      if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
      if (typeof app?.graph?._version === "number") app.graph._version++;
    }

    const controlSlotsBefore = getControlSlots(node);

    const lastInput = node.inputs[node.inputs.length - 1];
    if (lastInput?.link != null) {
      const nextName = getNextInName(node);

      // Determinar type heredado para el nuevo input
      let inputType = "LATENT";
      if (controlSlotsBefore.length > 0) {
        const lastControlSlot = controlSlotsBefore[controlSlotsBefore.length - 1];
        inputType = node.inputs[lastControlSlot]?.type || "LATENT";
      } else {
        const anyIn = (node.inputs || []).find(inp => inp && /^in\d+$/i.test(inp.name) && inp.type);
        inputType = anyIn?.type || "LATENT";
      }

      node.addInput(nextName, inputType);

      // Forzar re-render y versión
      if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
      if (typeof app?.graph?._version === "number") {
        try { app.graph._version++; } catch(e){}
      }
      try { if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true); } catch(e){}

      // REFRESCO MAS FUERTE: sincronizamos toggles y simulamos una ejecución/tick
      setTimeout(() => {
        try {
          // refrescar widgets/toggles según el nuevo estado de inputs
          refreshInputsAndToggles(node);
          updateActiveCount(node);
        } catch(err) { console.error("IntegerBypasser: post-add refresh error", err); }

        // intentar reproducir el efecto que produce la llegada de active_count:
        try {
          if (typeof node.onExecuted === "function") {
            node.onExecuted({ source: "IntegerBypasser.force_refresh" });
          }
        } catch (e) { /* swallow */ }

        try {
          if (typeof node.onExecute === "function") {
            node.onExecute();
          }
        } catch (e) { /* swallow */ }

        // última pasada de forzado UI
        try {
          if (app?.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
          if (typeof app?.graph?._version === "number") {
            try { app.graph._version++; } catch(e){}
          }
        } catch(e) { /* swallow */ }

      }, 20);

      return; // salimos, ya pedimos el refresh asíncrono
    }

    const controlSlots = getControlSlots(node);

    for (let toggleIndex = 0; toggleIndex < controlSlots.length; toggleIndex++) {
      const slotIndex = controlSlots[toggleIndex];
      ensureToggleForSlot(node, toggleIndex, slotIndex);
    }

    const maxToggleIndex = Math.max(0, controlSlots.length - 1);
    node.widgets = node.widgets.filter(w => {
      if (w.name?.startsWith("bypass_toggle_")) {
        const idx = parseInt(w.name.split("_").pop());
        if (isNaN(idx)) return false;
        return idx <= maxToggleIndex;
      }
      return true;
    });

  } catch (e) {
    console.error("IntegerBypasser: refreshInputsAndToggles error", e);
  }
}

/* --- Lectura y reacción al input active_count conectado --- */

function handleActiveCountInput(node) {
  try {
    const activeCountInputIndex = node.inputs?.findIndex(input => input.name === "active_count");
    if (activeCountInputIndex == null || activeCountInputIndex < 0) return;

    const activeCountInput = node.inputs[activeCountInputIndex];
    if (!activeCountInput || activeCountInput.link == null) {
      return;
    }

    const link = app.graph.links[activeCountInput.link];
    if (!link) return;
    const sourceNode = app.graph._nodes_by_id[link.origin_id];
    if (!sourceNode) return;

    let newValue = 0;
    if (sourceNode.outputs && sourceNode.outputs[link.origin_slot]) {
      const outputName = sourceNode.outputs[link.origin_slot].name;
      const sourceWidget = sourceNode.widgets?.find(w => w.name === outputName);
      if (sourceWidget) {
        newValue = safeInt(sourceWidget.value);
      } else if (sourceNode.properties && sourceNode.properties[outputName] !== undefined) {
        newValue = safeInt(sourceNode.properties[outputName]);
      } else if (typeof sourceNode.properties?.value === "number") {
        newValue = safeInt(sourceNode.properties.value);
      }
    }

    const activeCountWidget = node.widgets.find(w => w.name === "active_count");
    if (activeCountWidget && activeCountWidget.value !== newValue) {
      activeCountWidget.value = newValue;
      applyActiveCount(node, newValue);
      console.log(`IntegerBypasser: Updated active_count to ${newValue} from connected node`);
    }

  } catch (e) {
    console.error("IntegerBypasser: handleActiveCountInput error", e);
  }
}

/* --- Attachment: enganchar al nodo / eventos --- */

function attachIntegerBypasser(node) {
  if (node.__integer_bypasser_attached) return;
  node.__integer_bypasser_attached = true;

  let activeCountWidget = node.widgets.find(w => w.name === "active_count");

  const widgetCallback = (v) => {
    const count = safeInt(v);
    if (activeCountWidget && activeCountWidget.value !== count) {
      activeCountWidget.value = count;
    }
    applyActiveCount(node, count);
  };

  if (!activeCountWidget) {
    activeCountWidget = node.addWidget("number", "active_count", 0, widgetCallback,
      { min: 0, max: 99, step: 1, property: "active_count" });
  } else {
    activeCountWidget.callback = widgetCallback;
  }

  const originalOnConnectionChange = node.onConnectionChange;
  node.onConnectionChange = function(side, slot, connected) {
    originalOnConnectionChange?.apply(this, arguments);

    if (side === LiteGraph.INPUT) {
      setTimeout(() => {
        const input = node.inputs && node.inputs[slot];
        if (input && input.name === "active_count") {
          if (connected) {
            console.log("IntegerBypasser: active_count input connected");
            handleActiveCountInput(node);
          } else {
            console.log("IntegerBypasser: active_count input disconnected");
          }
        } else {
          refreshInputsAndToggles(node);
          updateActiveCount(node);
        }
      }, 50);
    }
  };

  const originalOnExecuted = node.onExecuted;
  node.onExecuted = function(message) {
    originalOnExecuted?.call(this, message);
    handleActiveCountInput(node);
  };

  setInterval(() => {
    const activeCountInput = node.inputs?.find(input => input.name === "active_count");
    if (activeCountInput?.link != null) {
      handleActiveCountInput(node);
    }
  }, 1000);

  setTimeout(() => refreshInputsAndToggles(node), 50);
}

/* --- Registro de la extensión --- */

app.registerExtension({
  name: "academiasd.IntegerBypasser",

  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name === "IntegerBypasser") {
      const onNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function() {
        onNodeCreated?.call(this);
        attachIntegerBypasser(this);
      };

      const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
      nodeType.prototype.getExtraMenuOptions = function(_, options) {
        getExtraMenuOptions?.apply(this, arguments);

        options.push({
          content: "Debug: Check active_count input",
          callback: () => {
            console.log("=== DEBUG IntegerBypasser ===");
            console.log("Node inputs:", this.inputs);
            console.log("Node widgets:", this.widgets);
            handleActiveCountInput(this);
            console.log("=== END DEBUG ===");
          }
        });
      };
    }
  },
});

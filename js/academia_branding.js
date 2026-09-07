// academia_branding.js
// Pinta el icono del canal en la barra de titulo de TODOS los nodos del
// paquete, para que se reconozcan sin tener que ponerlo en el nombre.
//
// Es automatico: no hay lista de nodos que mantener. ComfyUI marca cada clase
// con RELATIVE_PYTHON_MODULE y la publica en object_info como `python_module`
// (server.py), asi que basta con mirar de que carpeta viene el nodo. Cualquier
// nodo nuevo que anadas al paquete lo llevara sin tocar este fichero.
//
// Va en la esquina izquierda del titulo, ocupando el sitio del punto de
// plegar. LiteGraph tiene un hook justo para eso, onDrawTitleBox, que sustituye
// ese dibujo por el nuestro.
//
// Comprobado en el frontend 1.51.9: ese punto es solo decorativo, hacerle clic
// no pliega el nodo (ni en los nuestros ni en cualquier otro), asi que ponerle
// el icono encima no quita ninguna funcion. Si alguna version futura le
// devuelve el clic, seguira funcionando: aqui solo se cambia el dibujado.

import { app } from "../../scripts/app.js";

const PACK = "comfyui_academiasd";                 // se compara en minusculas
const ICON_URL = "/academia/brand_icon.png";

const SETTING_ON = "AcademiaSD.Branding.ShowIcon";
const SETTING_SIZE = "AcademiaSD.Branding.IconSize";
const SETTING_ALPHA = "AcademiaSD.Branding.Opacity";
const SETTING_ROUND = "AcademiaSD.Branding.Round";

let icon = null;
let ready = false;
let failed = false;

function ensureIcon() {
    if (icon || failed) return;
    icon = new Image();
    icon.onload = () => {
        ready = true;
        app.graph?.setDirtyCanvas(true, true);
    };
    icon.onerror = () => {
        failed = true;
        console.warn(`[AcademiaSD] icon not available at ${ICON_URL}. ` +
                     "Put it in assets/ as icono_Academia.png and restart ComfyUI.");
    };
    icon.src = ICON_URL;
}

// La API de ajustes ha cambiado de sitio entre versiones del frontend; se
// prueban las dos y se cae al valor por defecto sin romper el dibujado.
function setting(id, fallback) {
    try {
        const v = app.extensionManager?.setting?.get(id);
        if (v !== undefined && v !== null) return v;
    } catch (e) { /* sigue */ }
    try {
        const v = app.ui?.settings?.getSettingValue?.(id);
        if (v !== undefined && v !== null) return v;
    } catch (e) { /* sigue */ }
    return fallback;
}

function isOurs(nodeData) {
    return String(nodeData?.python_module || "").toLowerCase().includes(PACK);
}

// El punto de plegar por defecto, para cuando no hay icono que pintar. Sin
// esto, un icono que no cargue dejaria la esquina vacia.
function drawDefaultBox(node, ctx, cx, cy) {
    ctx.fillStyle = node.renderingBoxColor || LiteGraph.NODE_DEFAULT_BOXCOLOR || "#666";
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
}

// Sustituye el cuadro de la esquina del titulo. Firma de LiteGraph:
//   onDrawTitleBox(ctx, titleHeight, size, scale)
function drawBrandBox(node, ctx, titleHeight) {
    const th = titleHeight || LiteGraph.NODE_TITLE_HEIGHT;
    const cx = th * 0.5;          // mismo centro que usa el punto original
    const cy = th * -0.5;

    if (!ready || !setting(SETTING_ON, true)) {
        drawDefaultBox(node, ctx, cx, cy);
        return;
    }

    // 30 es el maximo geometrico: NODE_TITLE_HEIGHT vale 30, el icono va
    // centrado en (15, -15) y el texto del titulo empieza en x=30. A ese tamano
    // toca justo el borde izquierdo del nodo, el alto entero de la barra y el
    // comienzo del texto. Mas alla se sale de la barra y pisa el titulo.
    const size = Math.max(8, Math.min(30, Number(setting(SETTING_SIZE, 20)) || 20));
    const alpha = Math.max(0.1, Math.min(1, Number(setting(SETTING_ALPHA, 1)) || 1));

    ctx.save();
    ctx.globalAlpha = alpha;
    // El PNG puede no tener transparencia (el actual es RGB con fondo negro):
    // sobre un nodo de color se le veria el cuadrado. Recortarlo en circulo lo
    // resuelve sin depender de como este hecho el fichero.
    if (setting(SETTING_ROUND, true)) {
        ctx.beginPath();
        ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
        ctx.clip();
    }
    try {
        ctx.drawImage(icon, cx - size / 2, cy - size / 2, size, size);
    } catch (e) {
        ctx.restore();
        drawDefaultBox(node, ctx, cx, cy);
        return;
    }
    ctx.restore();
}

app.registerExtension({
    name: "AcademiaSD.Branding",

    settings: [
        {
            id: SETTING_ON,
            category: ["Academia SD", "Branding", "Show icon"],
            name: "Show the Academia SD icon in the node title corner",
            type: "boolean",
            defaultValue: true,
            onChange: () => app.graph?.setDirtyCanvas(true, true),
        },
        {
            id: SETTING_SIZE,
            category: ["Academia SD", "Branding", "Icon size"],
            name: "Icon size (px) — 30 fills the title bar edge to edge",
            type: "slider",
            attrs: { min: 8, max: 30, step: 1 },
            defaultValue: 20,
            onChange: () => app.graph?.setDirtyCanvas(true, true),
        },
        {
            id: SETTING_ROUND,
            category: ["Academia SD", "Branding", "Round icon"],
            name: "Clip the icon to a circle (hides the square edge on PNGs without transparency)",
            type: "boolean",
            defaultValue: true,
            onChange: () => app.graph?.setDirtyCanvas(true, true),
        },
        {
            id: SETTING_ALPHA,
            category: ["Academia SD", "Branding", "Icon opacity"],
            name: "Icon opacity",
            type: "slider",
            attrs: { min: 0.2, max: 1, step: 0.05 },
            defaultValue: 1,
            onChange: () => app.graph?.setDirtyCanvas(true, true),
        },
    ],

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isOurs(nodeData)) return;
        ensureIcon();

        const onDrawTitleBox = nodeType.prototype.onDrawTitleBox;
        nodeType.prototype.onDrawTitleBox = function (ctx, titleHeight, size, scale) {
            onDrawTitleBox?.apply(this, arguments);
            try { drawBrandBox(this, ctx, titleHeight); }
            catch (e) { /* nunca romper el pintado del grafo */ }
        };
    },
});

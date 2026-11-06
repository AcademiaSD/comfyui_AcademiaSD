import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Long Video: dos barras propias porque ComfyUI solo tiene una por nodo, y RelayVSR
// nativo la reinicia en cada ventana. Python envia el estado en asd_relayvsr_progress.
// Debajo va el reproductor del MP4 final, que se guarda con el workflow.
const NODE_NAMES = ["AcademiaSD_RelayVSRVideoFile", "AcademiaSD_RelayVSRNativeVideo"];

const CSS = `
.asd-rv { display:flex; flex-direction:column; gap:6px; height:100%; padding:4px 2px; box-sizing:border-box; font:11px 'Segoe UI', system-ui, sans-serif; color:#bbb; }
.asd-rv video { flex:1 1 0; min-height:0; width:100%; background:#111; border-radius:6px; }
.asd-rv [hidden] { display:none; }
.asd-rv-row { display:flex; flex-direction:column; gap:2px; }
.asd-rv-text { display:flex; justify-content:space-between; gap:8px; font-variant-numeric:tabular-nums; }
.asd-rv-text span:first-child { font-weight:600; color:#ddd; }
.asd-rv-track { height:8px; border-radius:4px; background:#2b2f36; overflow:hidden; }
.asd-rv-fill { height:100%; width:0; border-radius:4px; background:#3f8f58; transition:width .2s; }
.asd-rv-row.part .asd-rv-fill { background:#7fd3ff; }
.asd-rv-row.pulse .asd-rv-fill { width:35% !important; animation:asd-rv-pulse 1.4s ease-in-out infinite alternate; }
@keyframes asd-rv-pulse { from { margin-left:0; } to { margin-left:65%; } }
`;

function duracion(segundos) {
    const s = Math.round(segundos);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function fila(titulo, clase) {
    const el = document.createElement("div");
    el.className = `asd-rv-row ${clase}`;
    el.innerHTML = `<div class="asd-rv-text"><span>${titulo}</span><span></span></div><div class="asd-rv-track"><div class="asd-rv-fill"></div></div>`;
    const [nombre, valor] = el.querySelectorAll(".asd-rv-text span");
    return { el, nombre, valor, relleno: el.querySelector(".asd-rv-fill") };
}

function pintar(f, hecho, total, texto) {
    f.el.classList.remove("pulse");
    f.relleno.style.width = `${total ? (100 * hecho) / total : 0}%`;
    f.valor.textContent = texto;
}

app.registerExtension({
    name: "AcademiaSD.RelayVSRProgress",
    async setup() {
        const s = document.createElement("style");
        s.textContent = CSS;
        document.head.appendChild(s);

        api.addEventListener("asd_relayvsr_progress", ({ detail }) => {
            const id = String(detail.node).split(":").pop();
            app.graph.getNodeById(Number(id))?.asdProgreso?.(detail);
        });
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.includes(nodeData.name)) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const root = document.createElement("div");
            root.className = "asd-rv";
            const total = fila("Total", "total");
            const parte = fila("Part", "part");
            const video = document.createElement("video");
            video.controls = true;
            video.loop = true;
            video.playsInline = true;
            video.hidden = true;
            video.addEventListener("pointerdown", (e) => e.stopPropagation());
            root.append(total.el, parte.el, video);
            const self = this;
            this.properties = Object.assign({ asd_video: null }, this.properties);

            this.asdMostrar = () => {
                const v = self.properties.asd_video;
                if (!v) return;
                const q = new URLSearchParams({ filename: v.filename, subfolder: v.subfolder, type: v.type, rand: Date.now() });
                video.src = api.apiURL(`/view?${q}`);
                video.hidden = false;
                if (self.size[1] < 860) self.setSize([Math.max(self.size[0], 560), 860]);
            };
            // La subida de archivo trae su propia vista previa de la entrada, que llega
            // despues que este widget y le quitaria casi todo el alto al resultado.
            const ocultarEntrada = (oculta) => {
                const entrada = self.widgets.find((w) => w.name === "video-preview");
                if (entrada) entrada.hidden = oculta;
                self.setDirtyCanvas(true, true);
            };
            const addCustomWidget = this.addCustomWidget;
            this.addCustomWidget = function (widget) {
                const w = addCustomWidget.apply(this, arguments);
                if (widget.name === "video-preview" && !video.hidden) widget.hidden = true;
                return w;
            };
            video.addEventListener("loadeddata", () => ocultarEntrada(true));
            video.addEventListener("error", () => { video.hidden = true; ocultarEntrada(false); });

            this.asdProgreso = (p) => {
                const tiempo = p.eta == null ? "" : ` · ${duracion(p.eta)} left`;
                pintar(total, p.frames_done, p.frames, `${p.frames_done} / ${p.frames || "?"}${tiempo}`);
                if (p.phase === "wan") {
                    parte.nombre.textContent = "Wan references";
                    pintar(parte, p.part_done, p.part_size, p.part_size ? `${p.part_done} / ${p.part_size}` : "");
                    parte.el.classList.toggle("pulse", !p.part_size);
                } else if (p.phase === "parts") {
                    parte.nombre.textContent = `Part ${p.part} / ${p.parts}`;
                    pintar(parte, p.part_done, p.part_size, `${p.part_done} / ${p.part_size}`);
                } else {
                    parte.nombre.textContent = p.phase === "join" ? "Joining parts" : "Done";
                    pintar(parte, 1, 1, "");
                    parte.el.classList.toggle("pulse", p.phase === "join");
                }
            };

            this.addDOMWidget("relayvsr_progress", "relayvsr_progress", root, { getMinHeight: () => (video.hidden ? 72 : 320), serialize: false });
            return r;
        };

        // Las propiedades guardadas llegan despues de onNodeCreated.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this.asdMostrar?.();
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            if (message?.asd_video?.length) {
                this.properties.asd_video = message.asd_video[0];
                this.asdMostrar?.();
            }
        };
    },
});

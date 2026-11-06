import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Before / After: el MP4 trae before a la izquierda y after a la derecha, y aqui se
// dibujan las dos mitades en un canvas, separadas por la cortinilla.
const NODE_NAME = "AcademiaSD_BeforeAfter";

const CSS = `
.asd-ba { display:flex; flex-direction:column; gap:6px; height:100%; box-sizing:border-box; padding:4px 2px;
  font:12px 'Segoe UI', system-ui, sans-serif; color:#ddd; }
.asd-ba-view { position:relative; flex:1 1 0; min-height:0; background:#111; border-radius:6px; overflow:hidden; }
.asd-ba-view canvas { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; cursor:ew-resize; touch-action:none; }
.asd-ba-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#777; pointer-events:none; }
.asd-ba-tag { position:absolute; top:6px; padding:1px 7px; border-radius:4px; background:#0009; color:#fff; pointer-events:none; }
.asd-ba-tag.a { left:6px; } .asd-ba-tag.b { right:6px; }
.asd-ba-bar { display:flex; align-items:center; gap:6px; }
.asd-ba-bar button { background:#1f4a35; border:1px solid #3f8f58; border-radius:5px; color:#c8f7d6; padding:3px 9px; font:inherit; font-weight:600; min-width:64px; cursor:pointer; }
.asd-ba-bar input { flex:1; min-width:0; }
.asd-ba-bar span { color:#aaa; min-width:84px; text-align:right; font-variant-numeric:tabular-nums; }
.asd-ba [hidden] { display:none; }
`;

app.registerExtension({
    name: "AcademiaSD.BeforeAfter",
    async setup() {
        const s = document.createElement("style");
        s.textContent = CSS;
        document.head.appendChild(s);
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const self = this;
            this.properties = Object.assign({ preview: null, fps: 24, divider: 0.5 }, this.properties);

            const root = document.createElement("div");
            root.className = "asd-ba";
            root.innerHTML = `
                <div class="asd-ba-view">
                    <canvas></canvas>
                    <div class="asd-ba-empty">Run the node to compare</div>
                    <div class="asd-ba-tag a" hidden>Before</div>
                    <div class="asd-ba-tag b" hidden>After</div>
                </div>
                <div class="asd-ba-bar"><button>❚❚ Pause</button><input type="range" min="0" max="1000" value="0"><span>0 / 0</span></div>`;
            const canvas = root.querySelector("canvas");
            const contexto = canvas.getContext("2d");
            const vacio = root.querySelector(".asd-ba-empty");
            const etiquetas = root.querySelectorAll(".asd-ba-tag");
            const btnPlay = root.querySelector("button");
            const barra = root.querySelector("input");
            const cuenta = root.querySelector("span");
            const video = document.createElement("video");
            video.muted = true;
            video.loop = true;
            video.playsInline = true;

            const totalFrames = () => Math.max(1, Math.round(video.duration * self.properties.fps) || 1);
            const dibujar = () => {
                const ancho = video.videoWidth / 2, alto = video.videoHeight;
                if (!ancho) return;
                if (canvas.width !== ancho || canvas.height !== alto) { canvas.width = ancho; canvas.height = alto; }
                const x = Math.round(ancho * self.properties.divider);
                contexto.drawImage(video, ancho, 0, ancho, alto, 0, 0, ancho, alto);
                contexto.drawImage(video, 0, 0, x, alto, 0, 0, x, alto);
                contexto.fillStyle = "#fff";
                contexto.fillRect(x - 1, 0, Math.max(2, Math.round(ancho / 640)), alto);
                const frame = Math.min(totalFrames(), Math.floor(video.currentTime * self.properties.fps) + 1);
                cuenta.textContent = `${frame} / ${totalFrames()}`;
                if (!barra.matches(":active")) barra.value = 1000 * video.currentTime / (video.duration || 1);
            };
            const alSiguienteFrame = () => {
                dibujar();
                if (self.asdVideo === video) video.requestVideoFrameCallback(alSiguienteFrame);
            };
            this.asdVideo = video;
            video.addEventListener("loadeddata", () => {
                vacio.hidden = true;
                etiquetas.forEach((e) => { e.hidden = false; });
                dibujar();
            });
            video.addEventListener("seeked", dibujar);
            video.addEventListener("error", () => {
                vacio.hidden = false;
                vacio.textContent = "Run the node to compare";
                etiquetas.forEach((e) => { e.hidden = true; });
            });
            video.addEventListener("play", () => { btnPlay.textContent = "❚❚ Pause"; });
            video.addEventListener("pause", () => { btnPlay.textContent = "▶ Play"; });
            video.requestVideoFrameCallback(alSiguienteFrame);

            btnPlay.onclick = () => (video.paused ? video.play() : video.pause());
            barra.oninput = () => {
                video.pause();
                video.currentTime = (barra.value / 1000) * (video.duration || 0);
            };

            // object-fit deja bandas: la posicion se mide sobre la imagen, no sobre el canvas.
            const mover = (e) => {
                const caja = canvas.getBoundingClientRect();
                const proporcion = canvas.width / (canvas.height || 1);
                const ancho = Math.min(caja.width, caja.height * proporcion);
                const x = (e.clientX - caja.left - (caja.width - ancho) / 2) / ancho;
                self.properties.divider = Math.min(1, Math.max(0, x));
                dibujar();
            };
            // En fase de captura: con Nodes 2.0 el WidgetDOM hace stop de pointermove y pointerup.
            const soltar = () => {
                window.removeEventListener("pointermove", mover, true);
                window.removeEventListener("pointerup", soltar, true);
                window.removeEventListener("pointercancel", soltar, true);
            };
            canvas.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                mover(e);
                window.addEventListener("pointermove", mover, true);
                window.addEventListener("pointerup", soltar, true);
                window.addEventListener("pointercancel", soltar, true);
            });

            this.asdCargar = () => {
                const p = self.properties.preview;
                if (!p) return;
                const q = new URLSearchParams({ filename: p.filename, subfolder: p.subfolder, type: p.type });
                video.src = api.apiURL(`/view?${q}`);
                video.play().catch(() => {});
            };

            this.addDOMWidget("before_after", "before_after_viewer", root, { getMinHeight: () => 240, serialize: false });
            this.setSize([Math.max(this.size[0], 560), Math.max(this.size[1], 560)]);
            return r;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.asdVideo?.pause();
            this.asdVideo = null;
            return onRemoved?.apply(this, arguments);
        };

        // Las propiedades guardadas llegan despues de onNodeCreated.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this.asdCargar?.();
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            if (message?.asd_preview?.length) {
                this.properties.preview = message.asd_preview[0];
                this.properties.fps = message.asd_fps[0];
                this.asdCargar?.();
            }
        };
    },
});

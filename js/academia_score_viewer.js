import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { anotarSolfeo, calcularDesfase, filtrarVoz, ordenarAbc } from "./academia_score_core.js";
import ABCJS from "./abcjs/abcjs.js";

// Score Viewer: partitura ABC dibujada con abcjs (js/abcjs, MIT), compilado sin su
// sintetizador porque baja las muestras de internet: sin audio conectado el sonido se
// sintetiza aqui.
const NODE_NAME = "AcademiaSD_ScoreViewer";

const CSS = `
.asd-sv { display:flex; flex-direction:column; gap:6px; height:100%; box-sizing:border-box; padding:4px 2px;
  font:12px 'Segoe UI', system-ui, sans-serif; color:#ddd; }
.asd-sv-bar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.asd-sv button, .asd-sv select { background:#2b2f36; color:#ddd; border:1px solid #444; border-radius:5px; padding:3px 9px; font:inherit; cursor:pointer; }
.asd-sv button:hover { border-color:#7fd3ff; }
.asd-sv button.play { background:#1f4a35; border-color:#3f8f58; color:#c8f7d6; font-weight:600; min-width:64px; }
.asd-sv-seg { display:flex; }
.asd-sv-seg button { border-radius:0; margin-left:-1px; }
.asd-sv-seg button:first-child { border-radius:5px 0 0 5px; margin-left:0; }
.asd-sv-seg button:last-child { border-radius:0 5px 5px 0; }
.asd-sv-seg button.on { background:#7fd3ff; border-color:#7fd3ff; color:#10202b; font-weight:600; }
.asd-sv audio { flex:1 1 260px; min-width:200px; height:30px; }
.asd-sv input[type=number] { width:58px; background:#2b2f36; color:#ddd; border:1px solid #444; border-radius:5px; padding:2px 4px; font:inherit; }
.asd-sv [hidden] { display:none; }
.asd-sv label { display:flex; align-items:center; gap:4px; color:#aaa; }
.asd-sv-paper { position:relative; flex:1 1 0; min-height:0; overflow:scroll; background:#fff; color:#111; border-radius:6px; }
.asd-sv-paper::-webkit-scrollbar { width:14px; height:14px; }
.asd-sv-paper::-webkit-scrollbar-track, .asd-sv-paper::-webkit-scrollbar-corner { background:#d8dbe0; }
.asd-sv-paper::-webkit-scrollbar-thumb { background:#7a8594; border:2px solid #d8dbe0; border-radius:7px; }
.asd-sv-paper::-webkit-scrollbar-thumb:hover { background:#4f5a68; }
/* abcjs reescribe el estilo de su contenedor: la hoja es otro div, y al ser absoluta
   su altura no empuja al nodo. */
.asd-sv-sheet { position:absolute; left:0; top:0; width:100%; }
.asd-sv-paper .asd-sv-on, .asd-sv-paper .asd-sv-on path { fill:#d9159b; stroke:#d9159b; }
.asd-sv-empty { color:#777; padding:24px; text-align:center; }
.asd-sv-status { color:#ffb86b; font-size:11px; min-height:14px; }
`;

function tocar(audio, midi, segundos) {
    const t = audio.currentTime;
    const hz = 440 * 2 ** ((midi - 69) / 12);
    const fin = t + Math.max(0.15, segundos);
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "triangle";
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0008, fin);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(fin + 0.02);
}

const marcasDe = (visual) => {
    // Rellena midiPitches, que TimingCallbacks entrega en cada evento.
    visual.setUpAudio();
    return new ABCJS.TimingCallbacks(visual, {}).noteTimings.filter((m) => m.type === "event");
};

function situarAudio(abc, croma) {
    // Las dos voces aunque se muestre una: cuantas mas notas, mejor se situa.
    const [visual] = ABCJS.renderAbc("*", ordenarAbc(abc));
    const redonda = 60 / visual.getBpm() / visual.getBeatLength();
    const notas = marcasDe(visual).flatMap((m) => (m.midiPitches || []).map((n) => ({
        inicio: m.milliseconds / 1000, fin: m.milliseconds / 1000 + n.duration * redonda, nota: n.pitch,
    })));
    return calcularDesfase(croma, notas);
}

function descargar(nombre, tipo, texto) {
    const a = document.createElement("a");
    a.href = `data:${tipo};charset=utf-8,${encodeURIComponent(texto)}`;
    a.download = nombre;
    a.click();
}

app.registerExtension({
    name: "AcademiaSD.ScoreViewer",
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
            this.properties = Object.assign({ abc: "", transpose: 0, solfege: false, zoom: 100, voices: "both", audio: null, offset: 0 }, this.properties);

            const root = document.createElement("div");
            root.className = "asd-sv";
            root.innerHTML = `
                <div class="asd-sv-bar">
                    <button class="play">▶ Play</button>
                    <audio class="pista" controls hidden></audio>
                    <label class="sy" hidden>Offset <input type="number" class="of" step="0.05"> s</label>
                    <div class="asd-sv-seg">
                        <button data-voz="both">Both</button>
                        <button data-voz="Vocal">Vocal</button>
                        <button data-voz="Ins">Instrumental</button>
                    </div>
                    <label>Transpose <select class="tr"></select></label>
                    <label><input type="checkbox" class="so"> Do Re Mi</label>
                    <label>Zoom <select class="zo"></select></label>
                    <button class="svg">Save SVG</button>
                    <button class="pdf">Print / PDF</button>
                </div>
                <div class="asd-sv-paper"><div class="asd-sv-sheet"></div></div>
                <div class="asd-sv-status"></div>`;
            const [btnPlay, pista, ajuste, inOf, selTr, chkSo, selZo, papel, hoja, estado] = [".play", ".pista", ".sy", ".of", ".tr", ".so", ".zo", ".asd-sv-paper", ".asd-sv-sheet", ".asd-sv-status"].map((c) => root.querySelector(c));
            for (let i = 12; i >= -12; i--) selTr.add(new Option(i > 0 ? `+${i}` : String(i), i));
            for (const z of [100, 125, 150, 200, 300]) selZo.add(new Option(`${z}%`, z));
            // La rueda desplaza la partitura en vez de hacer zoom en el lienzo.
            // Se mueve a mano: los nodos clasicos cancelan el scroll nativo dentro del nodo.
            papel.addEventListener("wheel", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const paso = e.deltaMode === 1 ? 16 : 1;
                if (e.shiftKey) papel.scrollLeft += (e.deltaY || e.deltaX) * paso;
                else { papel.scrollTop += e.deltaY * paso; papel.scrollLeft += e.deltaX * paso; }
            }, { passive: false });
            // Nodes 2.0 solo cede la rueda al elemento con el foco.
            root.dataset.captureWheel = "true";
            papel.tabIndex = -1;
            papel.addEventListener("pointerenter", () => {
                if (document.activeElement === document.body) papel.focus({ preventScroll: true });
            });

            const botonesVoz = [...root.querySelectorAll("[data-voz]")];
            let visual = null, reloj = null, audio = null, encendidas = [], marcas = [], marca = -1;
            const apagar = () => {
                encendidas.forEach((e) => e.classList.remove("asd-sv-on"));
                encendidas = [];
            };
            const resaltar = (ev) => {
                apagar();
                encendidas = (ev.elements || []).flat();
                encendidas.forEach((e) => e.classList.add("asd-sv-on"));
                const nota = encendidas[0]?.getBoundingClientRect(), caja = papel.getBoundingClientRect();
                if (nota && (nota.bottom > caja.bottom || nota.top < caja.top)) papel.scrollTop += nota.top - caja.top - 24;
                if (nota && (nota.right > caja.right || nota.left < caja.left)) papel.scrollLeft += nota.left - caja.left - 24;
            };
            // Con audio manda su reloj, asi que saltar en la barra mueve tambien la partitura.
            const situar = () => {
                const ms = (pista.currentTime - self.properties.offset) * 1000;
                let i = marca;
                while (i + 1 < marcas.length && marcas[i + 1].milliseconds <= ms) i++;
                while (i >= 0 && marcas[i].milliseconds > ms) i--;
                if (i === marca) return;
                marca = i;
                if (i < 0) apagar();
                else resaltar(marcas[i]);
            };
            const seguir = () => {
                situar();
                if (!pista.paused) requestAnimationFrame(seguir);
            };
            pista.onplay = seguir;
            pista.onseeked = situar;
            const parar = () => {
                reloj?.stop();
                reloj = null;
                apagar();
                marca = -1;
                btnPlay.textContent = "▶ Play";
            };
            const dibujar = async () => {
                parar();
                const p = self.properties;
                selTr.value = p.transpose;
                chkSo.checked = p.solfege;
                selZo.value = p.zoom;
                botonesVoz.forEach((b) => b.classList.toggle("on", b.dataset.voz === p.voices));
                inOf.value = p.offset;
                btnPlay.hidden = !!p.audio;
                pista.hidden = ajuste.hidden = !p.audio;
                const fuente = p.audio ? api.apiURL(`/view?${new URLSearchParams(p.audio)}`) : "";
                if (pista.dataset.fuente !== fuente) {
                    pista.dataset.fuente = fuente;
                    if (fuente) pista.src = fuente;
                    else pista.removeAttribute("src");
                }
                estado.textContent = "";
                if (!p.abc?.trim()) {
                    visual = null;
                    marcas = [];
                    hoja.innerHTML = `<div class="asd-sv-empty">Connect an ABC score and run the workflow</div>`;
                    return;
                }
                let texto = ordenarAbc(filtrarVoz(p.abc, p.voices));
                if (p.transpose) texto = ABCJS.strTranspose(texto, ABCJS.renderAbc("*", texto), p.transpose);
                if (p.solfege) texto = anotarSolfeo(texto);
                [visual] = ABCJS.renderAbc(hoja, texto, { add_classes: true, responsive: "resize", staffwidth: 980 });
                // abcjs deja el contenedor al 100 %: el zoom se aplica despues.
                hoja.style.width = `${p.zoom}%`;
                marcas = p.audio ? marcasDe(visual) : [];
                situar();
                if (visual.warnings?.length) estado.textContent = `${visual.warnings.length} warnings in the score`;
            };
            self.asdDibujar = dibujar;
            // Los temporales se borran al reiniciar ComfyUI: se vuelve al sintetizador.
            pista.onerror = () => {
                self.properties.audio = null;
                dibujar();
            };

            btnPlay.onclick = async () => {
                if (reloj) return parar();
                if (!visual) return;
                audio ??= new AudioContext();
                await audio.resume();
                btnPlay.textContent = "■ Stop";
                const segundosRedonda = 60 / visual.getBpm() / visual.getBeatLength();
                visual.setUpAudio();
                reloj = new ABCJS.TimingCallbacks(visual, {
                    eventCallback: (ev) => {
                        if (!ev) return parar();
                        resaltar(ev);
                        for (const n of ev.midiPitches || []) tocar(audio, n.pitch, n.duration * segundosRedonda);
                    },
                });
                reloj.start();
            };
            botonesVoz.forEach((b) => { b.onclick = () => { self.properties.voices = b.dataset.voz; dibujar(); }; });
            inOf.onchange = () => { self.properties.offset = Number(inOf.value) || 0; situar(); };
            selTr.onchange = () => { self.properties.transpose = Number(selTr.value); dibujar(); };
            chkSo.onchange = () => { self.properties.solfege = chkSo.checked; dibujar(); };
            selZo.onchange = () => { self.properties.zoom = Number(selZo.value); hoja.style.width = `${selZo.value}%`; };
            root.querySelector(".svg").onclick = () => {
                const svg = papel.querySelector("svg");
                if (svg) descargar("score.svg", "image/svg+xml", new XMLSerializer().serializeToString(svg));
            };
            root.querySelector(".pdf").onclick = () => {
                const svg = papel.querySelector("svg");
                if (!svg) return;
                const marco = document.createElement("iframe");
                marco.style.cssText = "position:fixed;width:0;height:0;border:0";
                marco.srcdoc = `<!doctype html><title>Score</title><style>body{margin:0}svg{width:100%;height:auto}</style>${svg.outerHTML}`;
                marco.onload = () => {
                    marco.contentWindow.print();
                    setTimeout(() => marco.remove(), 1000);
                };
                document.body.appendChild(marco);
            };

            this.addDOMWidget("score", "score_viewer", root, { getMinHeight: () => 320, serialize: false });
            this.setSize([Math.max(this.size[0], 760), Math.max(this.size[1], 520)]);
            setTimeout(dibujar, 0);
            return r;
        };

        // Las propiedades guardadas llegan despues de onNodeCreated.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this.asdDibujar?.();
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = async function (message) {
            onExecuted?.apply(this, arguments);
            if (message?.abc?.length) {
                this.properties.abc = message.abc[message.abc.length - 1];
                this.properties.audio = message.sync_audio?.[0] ?? null;
                if (message.chroma) this.properties.offset = situarAudio(this.properties.abc, message.chroma[0]);
                this.asdDibujar?.();
            }
        };
    },
});

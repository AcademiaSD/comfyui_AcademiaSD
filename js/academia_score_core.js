// Score Viewer: prepara el ABC de YuE2 y SheetSage2 antes de dibujarlo. Viene sin
// espacios, asi que abcjs uniria todo un compas bajo una barra, y las secciones
// llegan como comentarios (% verse), que no se dibujan.
const NOMBRES = { C: "Do", D: "Re", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Si" };
const SUFIJOS = { "-2": "bb", "-1": "b", 0: "", 1: "#", 2: "x" };
const ALTERACION = { "^^": 2, "^": 1, "=": 0, "_": -1, "__": -2 };
const QUINTAS = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1 };
const TOKEN = /"[^"]*"|\[[A-Za-z]:[^\]]*\]|(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)(\d*)(\/\d*)?(-?)|([zZxX])(\d*)(\/\d*)?|[|:\]]+|\s+|./y;

const TRAMAS_POR_SEGUNDO = 20;  // nodes/academia_score_viewer.py usa la misma cifra

function armadura(clave) {
    const m = /^\s*([A-G])([#b]?)\s*(m(?!aj)|min)?/i.exec(clave);
    const alteradas = {};
    if (!m) return alteradas;
    let quintas = QUINTAS[m[1].toUpperCase()] + (m[2] === "#" ? 7 : m[2] === "b" ? -7 : 0) - (m[3] ? 3 : 0);
    const signo = Math.sign(quintas);
    const orden = signo > 0 ? "FCGDAEB" : "BEADGCF";
    // Mas de 7 no tiene armadura escrita: la segunda vuelta dobla las alteraciones.
    for (let i = 0; i < Math.abs(quintas); i++) alteradas[orden[i % 7]] = (alteradas[orden[i % 7]] || 0) + signo;
    return alteradas;
}

function fraccion(texto, porDefecto) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(texto);
    return m ? [Number(m[1]), Number(m[2])] : porDefecto;
}

function duracion(cifras, barra) {
    let n = cifras ? Number(cifras) : 1;
    if (barra) n /= barra.length > 1 ? Number(barra.slice(1)) : 2;
    return n;
}

function centrarTramas(m) {
    for (let t = 0; t < m.length; t += 12) {
        let media = 0;
        for (let n = 0; n < 12; n++) media += m[t + n] / 12;
        for (let n = 0; n < 12; n++) m[t + n] -= media;
    }
}

function centrarNotas(m) {
    for (let n = 0; n < 12; n++) {
        let media = 0;
        for (let t = n; t < m.length; t += 12) media += m[t] / (m.length / 12);
        for (let t = n; t < m.length; t += 12) m[t] -= media;
    }
}

// Recorre la musica: `pulsos` separa las notas por pulsos, `solfeo` escribe el
// nombre bajo cada nota y `secciones` convierte los comentarios en rotulos.
function recorrer(abc, { pulsos = false, solfeo = false, secciones = false }) {
    let compas = [4, 4], unidad = [1, 8], clave = {}, alteradas = {};
    let seccion = "";
    const salida = [];
    for (const linea of String(abc).split(/\r?\n/)) {
        if (!linea.trim()) continue;
        if (linea.startsWith("%")) {
            const nombre = /^%\s*([A-Za-z][\w -]*?)\s*$/.exec(linea);
            if (secciones && nombre) seccion = nombre[1][0].toUpperCase() + nombre[1].slice(1);
            else if (!secciones || linea.startsWith("%%")) salida.push(linea);
            continue;
        }
        if (/^[A-Za-z+]:/.test(linea)) {
            const valor = linea.slice(2);
            if (linea[0] === "M") compas = valor.trim() === "C|" ? [2, 2] : fraccion(valor, [4, 4]);
            if (linea[0] === "L") unidad = fraccion(valor, unidad);
            if (linea[0] === "K") clave = armadura(valor);
            if (linea[0] !== "T" || valor.trim()) salida.push(linea);
            continue;
        }
        const compuesto = compas[1] === 8 && compas[0] % 3 === 0 && compas[0] > 3;
        const pulso = (compuesto ? 3 / 8 : 1 / compas[1]) * unidad[1] / unidad[0];
        const compasEntero = compas[0] / compas[1] * unidad[1] / unidad[0];
        let posicion = 0, tramo = 0, ligada = false, pendiente = "", texto = "";
        TOKEN.lastIndex = 0;
        for (let m = TOKEN.exec(linea); m && m[0]; m = TOKEN.exec(linea)) {
            const t = m[0];
            if (t[0] === '"') { pendiente += t; continue; }
            if (t.startsWith("[") && t[2] === ":") {
                if (t[1] === "K") { clave = armadura(t.slice(3, -1)); alteradas = {}; }
                texto += t;
            } else if (m[2] || m[7]) {
                const rotulo = seccion && m[7] !== "x" ? `"^${seccion}"` : "";
                if (rotulo) seccion = "";
                let nombre = "";
                if (m[2]) {
                    const letra = m[2].toUpperCase();
                    if (m[1]) alteradas[letra] = ALTERACION[m[1]];
                    if (solfeo && !ligada) {
                        const alteracion = alteradas[letra] ?? clave[letra] ?? 0;
                        nombre = `"_${NOMBRES[letra]}${SUFIJOS[alteracion]}"`;
                    }
                    ligada = m[6] === "-";
                }
                const larga = duracion(m[2] ? m[4] : m[8], m[2] ? m[5] : m[9]);
                // Se corta la barra al pasar de pulso, aunque la nota no empiece justo en el.
                const pulsoActual = Math.floor(posicion / pulso + 1e-6);
                if (pulsos && pulsoActual > tramo && !texto.endsWith(" ")) texto += " ";
                tramo = pulsoActual;
                // Z4 es un solo signo: un silencio por compas lo alinea con la otra voz.
                const multiple = pulsos && m[7] === "Z" && Number.isInteger(compasEntero);
                const musica = multiple ? Array(Number(m[8] || 1)).fill(`z${compasEntero}`).join("|") : t;
                texto += rotulo + pendiente + nombre + musica;
                pendiente = "";
                posicion += larga;
            } else if (/\|/.test(t)) {
                texto += t;
                posicion = 0;
                tramo = 0;
                alteradas = {};
            } else {
                texto += t;
            }
        }
        salida.push(texto + pendiente);
    }
    return salida.join("\n");
}

// Deja solo una voz. Los campos y las secciones se conservan: estan fuera de los
// bloques de musica o valen para las dos voces.
export function filtrarVoz(abc, voz) {
    if (voz === "both") return abc;
    let actual = null;
    return String(abc).split(/\r?\n/).filter((linea) => {
        const v = /^V:\s*(\S+)/.exec(linea);
        if (v) {
            actual = v[1];
            return actual === voz;
        }
        return /^[A-Za-z+]:|^%/.test(linea) || actual === null || actual === voz;
    }).join("\n");
}

// Segundos que tarda la musica en llegar a la primera nota de la partitura.
// `croma` son 12 valores por trama y `notas` lista { inicio, fin, nota } en segundos.
export function calcularDesfase(croma, notas) {
    const tramas = croma.length / 12;
    const desde = -2 * TRAMAS_POR_SEGUNDO, hasta = 15 * TRAMAS_POR_SEGUNDO;
    const audio = Float32Array.from(croma);
    centrarNotas(audio);
    centrarTramas(audio);
    const largo = tramas - desde;
    const partitura = new Float32Array(largo * 12);
    for (const { inicio, fin, nota } of notas) {
        const a = Math.floor(inicio * TRAMAS_POR_SEGUNDO), b = Math.floor(fin * TRAMAS_POR_SEGUNDO) + 1;
        for (let t = a; t < Math.min(b, largo); t++) partitura[t * 12 + nota % 12] += 1;
    }
    centrarTramas(partitura);
    let mejor = -Infinity, desfase = 0;
    for (let lag = desde; lag < hasta; lag++) {
        let cruce = 0, energiaA = 0, energiaP = 0;
        for (let t = Math.max(0, lag); t < tramas; t++) {
            const q = t - lag;
            if (q >= largo) break;
            for (let n = 0; n < 12; n++) {
                const x = audio[t * 12 + n], y = partitura[q * 12 + n];
                cruce += x * y;
                energiaA += x * x;
                energiaP += y * y;
            }
        }
        const nivel = cruce / Math.sqrt(energiaA * energiaP || 1);
        if (nivel > mejor) { mejor = nivel; desfase = lag / TRAMAS_POR_SEGUNDO; }
    }
    return desfase;
}

export const ordenarAbc = (abc) => recorrer(abc, { pulsos: true, secciones: true });
export const anotarSolfeo = (abc) => recorrer(abc, { solfeo: true });

// ============================================================================
// SOLOCONTROL 360 — Gestão integrada de massa asfáltica
// Usina → Transporte → Pista → Laboratório → Relatório consolidado
// Papéis: técnico de usina · técnico de obra · coordenador geral
// Nuvem: Firebase Auth + Firestore (offline-first) + Storage (fotos)
// ============================================================================
import React, { useState, useEffect, useMemo, useRef } from "react";
import { auth, db, storage, firebaseConfig } from "./firebase";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, getAuth,
} from "firebase/auth";
import { initializeApp, getApps } from "firebase/app";
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, getDoc, getDocs, arrayUnion,
} from "firebase/firestore";
import { ref as sRef, uploadString, getDownloadURL } from "firebase/storage";

// ----------------------------------------------------------------------------
// Parâmetros técnicos (DNIT 031/2006-ES — confirmar sempre com o projeto)
// ----------------------------------------------------------------------------
const LIMITES = {
  tempSaidaMin: 150,   // °C — saída da usina
  tempSaidaMax: 177,   // °C — máx. absoluta da mistura
  tempAplicMin: 120,   // °C — mínima para distribuição/compactação
  perdaAlerta: 25,     // °C — perda térmica no transporte que gera alerta
  gcMin: 97,           // % — grau de compactação mínimo (ref. Marshall)
};
const CODIGO_SETUP = "SOLO360"; // código do primeiro acesso do coordenador

// ----------------------------------------------------------------------------
// Identidade visual
// ----------------------------------------------------------------------------
const C = {
  navy: "#16255F", navy2: "#0F1A45", red: "#D62A2A", amber: "#B45309",
  bg: "#EEF1F7", card: "#FFFFFF", line: "#DDE3EF", ink: "#1B2233",
  mut: "#5C6577", ok: "#15803D", okBg: "#E7F6EC", warnBg: "#FEF3E2",
  redBg: "#FDEAEA", blue: "#1D4ED8", blueBg: "#E8EFFD", pur: "#6D28D9",
  purBg: "#F1EBFD", grayBg: "#EEF1F7",
};
const F = {
  disp: "'Barlow Semi Condensed', 'Arial Narrow', sans-serif",
  body: "'Inter', -apple-system, 'Segoe UI', sans-serif",
};
const STATUS = {
  em_transito:   { rot: "Em trânsito",   cor: C.amber, bg: C.warnBg, ico: "🚚" },
  no_local:      { rot: "Na obra",       cor: C.blue,  bg: C.blueBg, ico: "📍" },
  descarregando: { rot: "Descarregando", cor: C.pur,   bg: C.purBg,  ico: "⬇️" },
  concluida:     { rot: "Concluída",     cor: C.ok,    bg: C.okBg,   ico: "✅" },
  nao_conforme:  { rot: "Não conforme",  cor: C.red,   bg: C.redBg,  ico: "⚠️" },
};

// ----------------------------------------------------------------------------
// Utilitários de data/hora
// ----------------------------------------------------------------------------
const hojeISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const agoraHM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const agoraISO = () => new Date().toISOString();
const fmtBR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
const fmtDataHora = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const minutosEntre = (h1, h2) => {
  if (!h1 || !h2) return null;
  const [a, b] = h1.split(":").map(Number), [c, d] = h2.split(":").map(Number);
  let m = c * 60 + d - (a * 60 + b);
  if (m < 0) m += 24 * 60;
  return m;
};
const fmtMin = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`);
const num = (v) => { const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? null : n; };
const rid = () => Math.random().toString(36).slice(2, 10);
const getIn = (obj, path) => path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);

// ----------------------------------------------------------------------------
// GPS → UTM (WGS84) — mesmo padrão das fotos de campo (ex.: 22K 768688 7591233)
// ----------------------------------------------------------------------------
function paraUTM(lat, lon) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const zona = Math.floor((lon + 180) / 6) + 1;
  const lam0 = (((zona - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, Cc = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lam - lam0);
  const M = a * ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const E = k0 * N * (A + ((1 - T + Cc) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * Cc - 58 * ep2) * A ** 5) / 120) + 500000;
  let Nn = k0 * (M + N * Math.tan(phi) * ((A * A) / 2 + ((5 - T + 9 * Cc + 4 * Cc * Cc) * A ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * Cc - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) Nn += 10000000;
  const banda = "CDEFGHJKLMNPQRSTUVWX"[Math.max(0, Math.min(19, Math.floor((lat + 80) / 8)))];
  return `${zona}${banda} ${Math.round(E)} ${Math.round(Nn)}`;
}
const pegarGPS = () => new Promise((res) => {
  if (!navigator.geolocation) return res(null);
  navigator.geolocation.getCurrentPosition(
    (p) => res(paraUTM(p.coords.latitude, p.coords.longitude)),
    () => res(null),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
  );
});

// ----------------------------------------------------------------------------
// Foto: compressão + marca d'água (data/hora, UTM, obra, SOLOCONTROL 360)
// ----------------------------------------------------------------------------
// Logo embutida no próprio código: a marca d'água funciona mesmo sem internet
// (obra com 4G instável) e nunca depende de download de arquivo.
const LOGO_MARCA = "data:image/png;base64,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";
let _logoMarca = null;
function carregarLogoMarca() {
  if (_logoMarca) return Promise.resolve(_logoMarca);
  return new Promise((res) => {
    const i = new Image();
    i.onload = () => { _logoMarca = i; res(i); };
    i.onerror = () => res(false);
    i.src = LOGO_MARCA;
  });
}
if (typeof window !== "undefined") carregarLogoMarca(); // deixa pronta desde a abertura do app
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
function dataExtenso() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0"), ss = String(d.getSeconds()).padStart(2, "0");
  return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()} às ${hh}:${mm}:${ss}`;
}

async function prepararFoto(file, obraNome) {
  const [utm, logo] = await Promise.all([pegarGPS(), carregarLogoMarca()]);
  const b64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = b64;
  });
  const MAX = 1400;
  const esc = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.round(img.width * esc), h = Math.round(img.height * esc);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const base = Math.min(w, h); // referência para escalar em foto deitada ou em pé

  // ---- Logo oficial gravada no canto superior direito ----
  if (logo) {
    const lw = Math.round(base * 0.30);
    const lh = Math.round(lw * (logo.height / logo.width));
    const mg = Math.round(base * 0.022);
    const x = w - lw - mg, y = mg;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = Math.round(base * 0.012); ctx.shadowOffsetY = 2;
    ctx.fillStyle = "#fff";
    const rr = Math.round(base * 0.008), pd = Math.round(base * 0.006);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x - pd, y - pd, lw + pd * 2, lh + pd * 2, rr) : ctx.rect(x - pd, y - pd, lw + pd * 2, lh + pd * 2);
    ctx.fill();
    ctx.restore();
    ctx.drawImage(logo, x, y, lw, lh);
  }

  // ---- Data/hora completa, coordenada e obra gravadas no rodapé ----
  const linhas = [dataExtenso(), utm || "GPS indisponível", obraNome ? `#${obraNome.toUpperCase()}` : "SOLOCONTROL"];
  const fs = Math.round(base * 0.045);
  const lh = Math.round(fs * 1.32);
  const mg = Math.round(base * 0.028);
  ctx.font = `700 ${fs}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  linhas.forEach((l, i) => {
    const y = h - mg - (linhas.length - 1 - i) * lh;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.85)";
    ctx.shadowBlur = Math.round(fs * 0.5);
    ctx.lineWidth = Math.max(2, Math.round(fs * 0.11));
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.strokeText(l, w - mg, y);   // contorno: legível em fundo claro ou escuro
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#fff";
    ctx.fillText(l, w - mg, y);
    ctx.restore();
  });
  return { id: rid(), b64: cv.toDataURL("image/jpeg", 0.82), utm: utm || "", hora: agoraHM() };
}

// ----------------------------------------------------------------------------
// Fila de envio para a nuvem (Storage) — NUNCA perder foto:
// se estiver sem sinal, a foto fica guardada no aparelho e o app reenvia
// sozinho quando a internet voltar.
// ----------------------------------------------------------------------------
// Rascunhos em memória: fotos e formulários abertos sobrevivem à troca de abas
const RASCUNHOS = {};

const LS_FILA = "sc360_fila_fotos";
const lerFila = () => { try { return JSON.parse(localStorage.getItem(LS_FILA) || "[]"); } catch { return []; } };
const gravarFila = (f) => { try { localStorage.setItem(LS_FILA, JSON.stringify(f)); } catch {} window.dispatchEvent(new Event("sc360fila")); };

async function subirStorage(b64, path) {
  const r = sRef(storage, path);
  await uploadString(r, b64, "data_url");
  return await getDownloadURL(r);
}

// Anexa uma foto num campo-array de um documento; se falhar o upload,
// registra o item como pendente e entra na fila de reenvio automático.
async function anexarFoto(docPath, campo, foto, legenda = "") {
  const path = `fotos/${docPath.replace(/\//g, "_")}/${foto.id}.jpg`;
  const item = { id: foto.id, url: null, hora: foto.hora, utm: foto.utm, legenda };
  try {
    item.url = await subirStorage(foto.b64, path);
    await updateDoc(doc(db, docPath), { [campo]: arrayUnion(item) });
  } catch {
    // Sem internet: grava o marcador no cache offline do Firestore (sincroniza depois)
    // e guarda a imagem na fila local de reenvio automático.
    updateDoc(doc(db, docPath), { [campo]: arrayUnion(item) }).catch(() => {});
    gravarFila([...lerFila(), { fid: foto.id, docPath, campo, path, b64: foto.b64 }]);
  }
  return item;
}

async function processarFila() {
  const fila = lerFila();
  if (!fila.length || !navigator.onLine) return;
  const restam = [];
  for (const it of fila) {
    try {
      const url = await subirStorage(it.b64, it.path);
      const dref = doc(db, it.docPath);
      const snap = await getDoc(dref);
      if (snap.exists()) {
        const arr = (getIn(snap.data(), it.campo) || []).map((f) => (f.id === it.fid ? { ...f, url } : f));
        await updateDoc(dref, { [it.campo]: arr });
      }
    } catch { restam.push(it); }
  }
  gravarFila(restam);
}

// ----------------------------------------------------------------------------
// Componentes de interface
// ----------------------------------------------------------------------------
const Logo = ({ s = 34 }) => (
  <img src="/marca.png" alt="Solocontrol" width={s} height={s}
    style={{ display: "block", background: "#fff", borderRadius: Math.round(s * 0.22), padding: Math.round(s * 0.1), boxSizing: "border-box", objectFit: "contain" }} />
);

const Btn = ({ children, tom = "navy", cheio = true, ...p }) => (
  <button {...p} style={{
    fontFamily: F.body, fontWeight: 700, fontSize: 15, cursor: "pointer",
    borderRadius: 12, padding: "13px 18px", width: cheio ? "100%" : "auto",
    background: tom === "navy" ? C.navy : tom === "red" ? C.red : tom === "ok" ? C.ok : tom === "claro" ? "#fff" : C.grayBg,
    color: tom === "claro" || tom === "cinza" ? C.navy : "#fff",
    border: tom === "claro" ? `1.5px solid ${C.line}` : "none",
    opacity: p.disabled ? 0.5 : 1, ...p.style,
  }}>{children}</button>
);

const Campo = ({ rotulo, sufixo, ...p }) => (
  <label style={{ display: "block", marginBottom: 12 }}>
    <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.mut, marginBottom: 5 }}>{rotulo}</span>
    <span style={{ position: "relative", display: "block" }}>
      <input {...p} style={{
        width: "100%", boxSizing: "border-box", fontFamily: F.body, fontSize: 16, color: C.ink,
        padding: "12px 13px", paddingRight: sufixo ? 46 : 13, borderRadius: 11,
        border: `1.5px solid ${C.line}`, background: "#fff", WebkitAppearance: "none", ...p.style,
      }} />
      {sufixo && <span style={{ position: "absolute", right: 13, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: C.mut, fontWeight: 600 }}>{sufixo}</span>}
    </span>
  </label>
);

const Sel = ({ rotulo, children, ...p }) => (
  <label style={{ display: "block", marginBottom: 12 }}>
    <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.mut, marginBottom: 5 }}>{rotulo}</span>
    <select {...p} style={{
      width: "100%", boxSizing: "border-box", fontFamily: F.body, fontSize: 16, color: C.ink,
      padding: "12px 10px", borderRadius: 11, border: `1.5px solid ${C.line}`, background: "#fff", ...p.style,
    }}>{children}</select>
  </label>
);

const Cartao = ({ children, style }) => (
  <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.line}`, marginBottom: 12, ...style }}>{children}</div>
);

const Chip = ({ st }) => {
  const s = STATUS[st] || STATUS.em_transito;
  return <span style={{ fontSize: 12, fontWeight: 700, color: s.cor, background: s.bg, padding: "4px 10px", borderRadius: 99, whiteSpace: "nowrap" }}>{s.ico} {s.rot}</span>;
};

const Titulo = ({ children, sub }) => (
  <div style={{ margin: "4px 2px 12px" }}>
    <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 22, color: C.navy, textTransform: "uppercase", letterSpacing: 0.3 }}>{children}</div>
    {sub && <div style={{ fontSize: 13, color: C.mut, marginTop: 2 }}>{sub}</div>}
  </div>
);

const Linha = ({ k, v, forte }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", fontSize: 14, borderBottom: `1px dashed ${C.line}` }}>
    <span style={{ color: C.mut }}>{k}</span>
    <span style={{ fontWeight: forte ? 800 : 600, color: forte ? C.navy : C.ink, textAlign: "right" }}>{v}</span>
  </div>
);

async function baixarFoto(src, nome) {
  try {
    const blob = await (await fetch(src)).blob();
    const file = new File([blob], nome, { type: blob.type || "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] }); // iPhone: abre "Salvar imagem"
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nome; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { if (e?.name !== "AbortError") alert("Não foi possível baixar a foto. Verifique a internet."); }
}

function VisorFoto({ src, nome, fechar }) {
  return (
    <div className="nao-imprimir" onClick={fechar} style={{ position: "fixed", inset: 0, zIndex: 120, background: "rgba(8,12,32,.94)", display: "flex", flexDirection: "column", padding: "14px" }}>
      <div style={{ flex: 1, display: "grid", placeItems: "center", minHeight: 0 }}>
        <img src={src} alt="" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,.5)" }} />
      </div>
      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 10, paddingTop: 12, paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
        <Btn tom="red" onClick={() => baixarFoto(src, nome)} style={{ flex: 1 }}>⬇️ Baixar / salvar na galeria</Btn>
        <Btn tom="claro" cheio={false} onClick={fechar} style={{ padding: "13px 22px" }}>Fechar</Btn>
      </div>
    </div>
  );
}

const Miniaturas = ({ fotos = [], locais = [], aoRemoverLocal }) => {
  const [ver, setVer] = useState(null);
  if (!fotos.length && !locais.length) return null;
  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {fotos.map((f) => (
          <div key={f.id} style={{ position: "relative" }}>
            {f.url
              ? <img src={f.url} alt="" onClick={() => setVer({ src: f.url, nome: `solocontrol-${f.id}.jpg` })} style={{ width: 74, height: 74, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.line}`, cursor: "pointer" }} />
              : <div style={{ width: 74, height: 74, borderRadius: 10, background: C.grayBg, display: "grid", placeItems: "center", fontSize: 11, color: C.mut, textAlign: "center", border: `1px dashed ${C.line}` }}>⏳ enviando<br />p/ nuvem</div>}
          </div>
        ))}
        {locais.map((f, i) => (
          <div key={f.id} style={{ position: "relative" }}>
            <img src={f.b64} alt="" onClick={() => setVer({ src: f.b64, nome: `solocontrol-${f.id}.jpg` })} style={{ width: 74, height: 74, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.line}`, cursor: "pointer" }} />
            {aoRemoverLocal && <button onClick={() => aoRemoverLocal(i)} style={{ position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 99, border: "none", background: C.red, color: "#fff", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>×</button>}
          </div>
        ))}
      </div>
      {ver && <VisorFoto {...ver} fechar={() => setVer(null)} />}
    </>
  );
};

// Botão de câmera: docPath definido → envia direto pra nuvem;
// sem docPath → guarda localmente até o registro ser salvo (modo diferido).
function BotaoFoto({ obraNome, docPath, campo, legenda, aoLocal, rotulo = "📷 Câmera" }) {
  const refCam = useRef(null);
  const refGal = useRef(null);
  const [ocupado, setOcupado] = useState(false);
  const processar = async (files) => {
    if (!files?.length) return;
    setOcupado(true);
    try {
      for (const file of files) {
        const foto = await prepararFoto(file, obraNome);
        if (docPath) await anexarFoto(docPath, campo, foto, legenda || "");
        else aoLocal && aoLocal(foto);
      }
    } finally { setOcupado(false); }
  };
  return (
    <>
      <input ref={refCam} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ""; processar(fs); }} />
      <input ref={refGal} type="file" accept="image/*" multiple style={{ display: "none" }}
        onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ""; processar(fs); }} />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn tom="claro" cheio={false} onClick={() => refCam.current?.click()} disabled={ocupado} style={{ padding: "11px 10px", flex: 1.4, whiteSpace: "nowrap" }}>
          {ocupado ? "Processando…" : rotulo}
        </Btn>
        <Btn tom="claro" cheio={false} onClick={() => refGal.current?.click()} disabled={ocupado} style={{ padding: "11px 10px", flex: 1, whiteSpace: "nowrap" }}>
          🖼️ Galeria
        </Btn>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------
// Indicador de sincronização com a nuvem
// ----------------------------------------------------------------------------
function BadgeNuvem() {
  const [online, setOnline] = useState(navigator.onLine);
  const [pend, setPend] = useState(lerFila().length);
  useEffect(() => {
    const on = () => { setOnline(true); processarFila(); };
    const off = () => setOnline(false);
    const fila = () => setPend(lerFila().length);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("sc360fila", fila);
    const t = setInterval(() => { processarFila(); fila(); }, 25000);
    processarFila();
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); window.removeEventListener("sc360fila", fila); clearInterval(t); };
  }, []);
  const cor = !online ? C.amber : pend ? C.blue : "#7CE0A3";
  const txt = !online ? "Offline — salvando no aparelho" : pend ? `Enviando ${pend} foto(s)…` : "Nuvem ✓";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, color: "#fff", background: "rgba(255,255,255,.12)", padding: "5px 10px", borderRadius: 99 }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: cor }} />{txt}
    </span>
  );
}

// ----------------------------------------------------------------------------
// Login + primeiro acesso do coordenador
// ----------------------------------------------------------------------------
function TelaLogin() {
  const [modo, setModo] = useState("login");
  const [f, setF] = useState({ nome: "", email: "", senha: "", codigo: "" });
  const [erro, setErro] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const m = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const entrar = async () => {
    setErro(""); setOcupado(true);
    try { await signInWithEmailAndPassword(auth, f.email.trim(), f.senha); }
    catch { setErro("E-mail ou senha inválidos."); }
    setOcupado(false);
  };
  const criarCoordenador = async () => {
    setErro("");
    if (f.codigo.trim().toUpperCase() !== CODIGO_SETUP) return setErro("Código de configuração incorreto.");
    if (!f.nome.trim() || f.senha.length < 6) return setErro("Preencha o nome e uma senha com 6+ caracteres.");
    setOcupado(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, f.email.trim(), f.senha);
      await setDoc(doc(db, "usuarios", cred.user.uid), {
        nome: f.nome.trim(), email: f.email.trim(), papel: "coordenador",
        ativo: true, obraId: "", criadoEm: agoraISO(),
      });
    } catch (e) { setErro(e.code === "auth/email-already-in-use" ? "E-mail já cadastrado." : "Não foi possível criar. Verifique a internet."); }
    setOcupado(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(180deg, ${C.navy} 0%, ${C.navy2} 100%)`, display: "grid", placeItems: "center", padding: 20, fontFamily: F.body }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <img src="/logo-solocontrol.png" alt="Solocontrol — Qualidade que constrói confiança"
            style={{ width: 250, maxWidth: "82%", borderRadius: 18, display: "block", margin: "0 auto", boxShadow: "0 10px 30px rgba(0,0,0,.35)" }} />
          <div style={{ color: "#AEB8E0", fontSize: 13, marginTop: 2 }}>Usina · Transporte · Pista · Laboratório</div>
        </div>
        <div style={{ background: "#fff", borderRadius: 18, padding: 20 }}>
          {modo === "setup" && <Campo rotulo="Seu nome completo" value={f.nome} onChange={m("nome")} placeholder="Ex.: André Marquini" />}
          <Campo rotulo="E-mail" type="email" autoCapitalize="none" value={f.email} onChange={m("email")} placeholder="voce@solocontrol.com.br" />
          <Campo rotulo="Senha" type="password" value={f.senha} onChange={m("senha")} placeholder="••••••" />
          {modo === "setup" && <Campo rotulo="Código de configuração inicial" value={f.codigo} onChange={m("codigo")} placeholder="Fornecido na implantação" />}
          {erro && <div style={{ color: C.red, fontSize: 13.5, fontWeight: 600, marginBottom: 10 }}>{erro}</div>}
          <Btn onClick={modo === "login" ? entrar : criarCoordenador} disabled={ocupado}>
            {ocupado ? "Aguarde…" : modo === "login" ? "Entrar" : "Criar acesso do coordenador"}
          </Btn>
          <button onClick={() => { setModo(modo === "login" ? "setup" : "login"); setErro(""); }}
            style={{ background: "none", border: "none", color: C.mut, fontSize: 13, fontWeight: 600, marginTop: 14, width: "100%", cursor: "pointer" }}>
            {modo === "login" ? "Primeiro acesso? Configurar coordenador" : "← Voltar ao login"}
          </button>
        </div>
        
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Estrutura do app após login
// ----------------------------------------------------------------------------
function Shell({ perfil, children, abas, aba, setAba }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: F.body, paddingBottom: 86 }}>
      <header style={{
        background: `linear-gradient(180deg, ${C.navy} 0%, ${C.navy2} 100%)`, color: "#fff",
        padding: "calc(env(safe-area-inset-top, 0px) + 12px) 16px 12px",
        position: "sticky", top: 0, zIndex: 40,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, maxWidth: 900, margin: "0 auto" }}>
          <Logo s={32} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 17, letterSpacing: 0.6 }}>SOLOCONTROL</div>
            <div style={{ fontSize: 11, color: "#AEB8E0" }}>{perfil.nome} · {perfil.papel === "coordenador" ? "Coordenação" : perfil.papel === "usina" ? "Técnico de usina" : perfil.papel === "ambos" ? "Usina + Obra" : perfil.papel === "diretoria" ? "Diretoria" : "Técnico de obra"}</div>
          </div>
          <BadgeNuvem />
          <button onClick={() => signOut(auth)} title="Sair" style={{ background: "rgba(255,255,255,.12)", border: "none", color: "#fff", borderRadius: 10, padding: "7px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Sair</button>
        </div>
      </header>
      <main style={{ maxWidth: 900, margin: "0 auto", padding: 14 }}>{children}</main>
      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: `1px solid ${C.line}`,
        display: "flex", justifyContent: "space-around", padding: "8px 4px calc(env(safe-area-inset-bottom, 0px) + 8px)", zIndex: 40,
      }}>
        {abas.map((a) => (
          <button key={a.id} onClick={() => setAba(a.id)} style={{
            background: "none", border: "none", cursor: "pointer", padding: "4px 6px", minWidth: 0,
            color: aba === a.id ? C.navy : C.mut, fontWeight: aba === a.id ? 800 : 600, fontFamily: F.body, fontSize: 12,
          }}>
            <div style={{ fontSize: 20 }}>{a.ico}</div>{a.rot}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Hooks de dados (tempo real, com cache offline do Firestore)
// ----------------------------------------------------------------------------
function useObras(apenasAtivas = true) {
  const [obras, setObras] = useState([]);
  useEffect(() => onSnapshot(collection(db, "obras"), (s) => {
    const l = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    l.sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
    setObras(apenasAtivas ? l.filter((o) => o.status === "ativa") : l);
  }), [apenasAtivas]);
  return obras;
}
function useCargasDia(dataRef) {
  const [cargas, setCargas] = useState([]);
  useEffect(() => onSnapshot(query(collection(db, "cargas"), where("dataRef", "==", dataRef)), (s) => {
    const l = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    l.sort((a, b) => (a.horaSaida || "").localeCompare(b.horaSaida || ""));
    setCargas(l);
  }), [dataRef]);
  return cargas;
}
const edicao = (perfil) => ({ por: perfil.nome, uid: perfil.uid, em: agoraISO() });

// ============================================================================
// PAPEL: TÉCNICO DE USINA
// ============================================================================
function TelaUsina({ perfil, aba }) {
  return aba === "nova" ? <UsinaNovaCarga perfil={perfil} /> : <UsinaCargasDia perfil={perfil} />;
}

const RASCUNHO = "sc360_rascunho_carga";
function UsinaNovaCarga({ perfil }) {
  const obras = useObras();
  const [f, setF] = useState(() => {
    try { return { ...JSON.parse(localStorage.getItem(RASCUNHO) || "{}") }; } catch { return {}; }
  });
  const [fotos, setFotos] = useState(() => RASCUNHOS.fotosNovaCarga || []);
  const [msg, setMsg] = useState("");
  const [salvando, setSalvando] = useState(false);
  const m = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  // Rascunho automático no aparelho (não perde nem fechando o app)
  useEffect(() => { try { localStorage.setItem(RASCUNHO, JSON.stringify(f)); } catch {} }, [f]);
  // Fotos pendentes seguram ao navegar entre as abas, até lançar a carga
  useEffect(() => { RASCUNHOS.fotosNovaCarga = fotos; }, [fotos]);

  const obra = obras.find((o) => o.id === f.obraId);
  const t = num(f.tempSaida);
  const tempFora = t != null && (t < LIMITES.tempSaidaMin || t > LIMITES.tempSaidaMax);

  const salvar = async () => {
    setMsg("");
    if (!f.obraId) return setMsg("Selecione a obra de destino.");
    if (!f.usina?.trim()) return setMsg("Informe a usina de origem.");
    if (!f.placa?.trim() || t == null) return setMsg("Preencha a placa e a temperatura de saída.");
    setSalvando(true);
    try {
      const dados = {
        dataRef: hojeISO(), obraId: f.obraId, obraNome: obra?.nome || "",
        usina: f.usina.trim(), placa: f.placa.trim().toUpperCase(),
        nf: "", tonelagem: null, // informados pela equipe da obra, que recebe a nota fiscal
        tempSaida: t, horaSaida: f.horaSaida || agoraHM(),
        conformeSaida: !tempFora, status: "em_transito",
        fotosUsina: [], chegada: null, descarga: null, transporte: null,
        criadoPor: { uid: perfil.uid, nome: perfil.nome }, criadoEm: agoraISO(), ultimaEdicao: edicao(perfil),
      };
      // Gravação offline-first: o id é gerado no aparelho e o Firestore
      // sincroniza sozinho quando houver internet — nunca trava nem perde.
      const dref = doc(collection(db, "cargas"));
      setDoc(dref, dados).catch(() => {});
      fotos.forEach((foto) => anexarFoto(`cargas/${dref.id}`, "fotosUsina", foto, "Carregamento na usina"));
      setF((v) => ({ obraId: v.obraId, usina: v.usina })); // mantém obra e usina p/ próxima carga
      setFotos([]);
      delete RASCUNHOS.fotosNovaCarga;
      setMsg("ok");
    } catch { setMsg("Falha ao salvar — os dados continuam no rascunho, tente de novo."); }
    setSalvando(false);
  };

  return (
    <>
      <Titulo sub="Ao salvar, o boletim de descarga é aberto automaticamente para o técnico da obra.">Nova carga</Titulo>
      <Cartao>
        <Sel rotulo="Obra de destino *" value={f.obraId || ""} onChange={m("obraId")}>
          <option value="">Selecione…</option>
          {obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
        </Sel>
        <Campo rotulo="Usina de origem *" value={f.usina || ""} onChange={m("usina")} placeholder="Ex.: AUTEM — Araraquara" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Campo rotulo="Placa do caminhão *" value={f.placa || ""} onChange={m("placa")} placeholder="AXE1F20" autoCapitalize="characters" />
          <Campo rotulo="Temp. de saída *" sufixo="°C" value={f.tempSaida || ""} onChange={m("tempSaida")} placeholder="160" inputMode="decimal" />
          <Campo rotulo="Hora de saída" type="time" value={f.horaSaida || agoraHM()} onChange={m("horaSaida")} />
        </div>
        <div style={{ fontSize: 12.5, color: C.mut, background: C.blueBg, borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>ℹ️ Nota fiscal e peso são informados pela equipe da obra, que recebe a nota em mãos.</div>
        {tempFora && <div style={{ background: C.redBg, color: C.red, fontSize: 13, fontWeight: 600, borderRadius: 10, padding: "9px 12px", marginBottom: 10 }}>
          ⚠️ Fora da faixa {LIMITES.tempSaidaMin}–{LIMITES.tempSaidaMax} °C — a carga será marcada como não conforme na saída.
        </div>}
        <BotaoFoto obraNome={obra?.nome} aoLocal={(foto) => setFotos((v) => [...v, foto])} rotulo="📷 Fotos do carregamento" />
        <Miniaturas locais={fotos} aoRemoverLocal={(i) => setFotos((v) => v.filter((_, j) => j !== i))} />
        <div style={{ height: 12 }} />
        <Btn onClick={salvar} disabled={salvando}>{salvando ? "Salvando na nuvem…" : "Lançar carga → abrir boletim na obra"}</Btn>
        {msg === "ok" && <div style={{ color: C.ok, fontWeight: 700, fontSize: 14, marginTop: 10, textAlign: "center" }}>✅ Carga lançada — boletim enviado à obra.</div>}
        {msg && msg !== "ok" && <div style={{ color: C.red, fontWeight: 600, fontSize: 13.5, marginTop: 10 }}>{msg}</div>}
      </Cartao>
    </>
  );
}

function UsinaCargasDia({ perfil }) {
  const cargas = useCargasDia(hojeISO());
  const minhas = cargas;
  const ton = minhas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  return (
    <>
      <Titulo sub={`${fmtBR(hojeISO())} · ${minhas.length} carga(s) · ${ton.toFixed(1)} t`}>Cargas do dia</Titulo>
      {!minhas.length && <Cartao><div style={{ color: C.mut, textAlign: "center", padding: 10 }}>Nenhuma carga lançada hoje. Toque em “Nova carga” para começar.</div></Cartao>}
      {minhas.map((c) => (
        <Cartao key={c.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 18, color: C.navy }}>{c.placa}{c.tonelagem != null ? ` · ${c.tonelagem} t` : ""}</div>
            <Chip st={c.status} />
          </div>
          <Linha k="Obra" v={c.obraNome} />
          <Linha k="Saída da usina" v={`${c.horaSaida} · ${c.tempSaida} °C`} />
          {c.chegada && <Linha k="Chegada na obra" v={`${c.chegada.hora} · ${c.chegada.temp} °C`} />}
          {c.transporte && <Linha k="Transporte" v={`${fmtMin(c.transporte.minutos)} · perda ${c.transporte.perda ?? "—"} °C`} forte />}
        </Cartao>
      ))}
    </>
  );
}

// ============================================================================
// PAPEL: TÉCNICO DE OBRA
// ============================================================================
function TelaObra({ perfil, aba }) {
  const obras = useObras();
  const [obraId, setObraId] = useState(() => localStorage.getItem("sc360_obra_dia") || perfil.obraId || "");
  const escolher = (id) => {
    setObraId(id);
    localStorage.setItem("sc360_obra_dia", id);
    updateDoc(doc(db, "usuarios", perfil.uid), { obraId: id }).catch(() => {});
  };
  const obra = obras.find((o) => o.id === obraId);
  return (
    <>
      <Cartao style={{ background: C.navy, border: "none" }}>
        <Sel rotulo={<span style={{ color: "#AEB8E0" }}>Obra em que estou hoje</span>} value={obraId} onChange={(e) => escolher(e.target.value)} style={{ fontWeight: 700 }}>
          <option value="">Selecionar obra…</option>
          {obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
        </Sel>
        {obra && <div style={{ color: "#AEB8E0", fontSize: 12.5, marginTop: -4 }}>{obra.local} {obra.espessuraProjeto ? `· espessura de projeto ${obra.espessuraProjeto} cm` : ""}</div>}
      </Cartao>
      {!obraId
        ? <Cartao><div style={{ color: C.mut, textAlign: "center", padding: 10 }}>Selecione a obra para receber os boletins de descarga.</div></Cartao>
        : aba === "fechamento"
          ? (obra
            ? <ObraFechamento perfil={perfil} obra={obra} />
            : <Cartao><div style={{ color: C.mut, textAlign: "center", padding: 10 }}>Carregando obra…</div></Cartao>)
          : <ObraBoletins perfil={perfil} obra={obra} />}
    </>
  );
}

function ObraBoletins({ perfil, obra }) {
  const cargas = useCargasDia(hojeISO()).filter((c) => c.obraId === obra?.id);
  const ton = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  return (
    <>
      <Titulo sub={`${fmtBR(hojeISO())} · ${cargas.length} boletim(ns) · ${ton.toFixed(1)} t`}>Boletins de descarga</Titulo>
      {!cargas.length && <Cartao><div style={{ color: C.mut, textAlign: "center", padding: 10 }}>Nenhuma carga lançada pela usina para esta obra hoje.<br />Assim que lançarem, o boletim aparece aqui sozinho.</div></Cartao>}
      {cargas.map((c) => <Boletim key={c.id} c={c} perfil={perfil} obra={obra} />)}
    </>
  );
}

function Boletim({ c, perfil, obra }) {
  const dp = `cargas/${c.id}`;
  const [ch, setCh] = useState({ hora: agoraHM(), temp: "" });
  const [nt, setNt] = useState({ nf: c.nf || "", ton: c.tonelagem ?? "" });
  useEffect(() => { setNt({ nf: c.nf || "", ton: c.tonelagem ?? "" }); }, [c.nf, c.tonelagem]);
  const [de, setDe] = useState({ tempAplicacao: "", trecho: "", espessura: "", clima: "", obs: "" });
  const [editar, setEditar] = useState(false);
  useEffect(() => { if (c.chegada) setCh({ hora: c.chegada.hora || agoraHM(), temp: c.chegada.temp ?? "" }); }, [c.chegada?.hora]);
  useEffect(() => { if (c.descarga) setDe((v) => ({ ...v, ...c.descarga })); }, [c.descarga?.inicio]);

  // Salvamento automático campo a campo direto na nuvem
  const salvarCampo = (caminho, v) => updateDoc(doc(db, dp), { [caminho]: v, ultimaEdicao: edicao(perfil) }).catch(() => {});

  const confirmarChegada = () => {
    const minutos = minutosEntre(c.horaSaida, ch.hora);
    const t = num(ch.temp);
    const upd = {
      "chegada.hora": ch.hora, "chegada.registradoPor": perfil.nome,
      "transporte.minutos": minutos, status: "no_local", ultimaEdicao: edicao(perfil),
    };
    if (t != null) { upd["chegada.temp"] = t; upd["transporte.perda"] = c.tempSaida != null ? Math.round((c.tempSaida - t) * 10) / 10 : null; }
    updateDoc(doc(db, dp), upd).catch(() => {});
  };
  const salvarTempChegada = (v) => {
    const t = num(v); if (t == null) return;
    updateDoc(doc(db, dp), {
      "chegada.temp": t,
      "transporte.perda": c.tempSaida != null ? Math.round((c.tempSaida - t) * 10) / 10 : null,
      ultimaEdicao: edicao(perfil),
    }).catch(() => {});
  };
  const salvarNota = () => salvarCampo("nf", (nt.nf || "").trim());
  const salvarPeso = () => salvarCampo("tonelagem", num(nt.ton));
  const camposNotaPeso = (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      <Campo rotulo="Nota fiscal" inputMode="numeric" value={nt.nf} onChange={(e) => setNt({ ...nt, nf: e.target.value })} onBlur={salvarNota} placeholder="8535" />
      <Campo rotulo="Peso da nota" sufixo="t" inputMode="decimal" value={nt.ton} onChange={(e) => setNt({ ...nt, ton: e.target.value })} onBlur={salvarPeso} placeholder="27,79" />
    </div>
  );
  const iniciarDescarga = () => updateDoc(doc(db, dp), { "descarga.inicio": agoraHM(), status: "descarregando", ultimaEdicao: edicao(perfil) }).catch(() => {});
  const finalizar = () => {
    const t = num(de.tempAplicacao);
    if (t == null) return alert("Informe a temperatura na aplicação.");
    if (!de.trecho?.trim()) return alert("Informe o trecho/estaca.");
    if ((!(nt.nf || "").trim() || num(nt.ton) == null) && !confirm("Nota fiscal e/ou peso ainda não informados. Finalizar mesmo assim?")) return;
    const conforme = t >= LIMITES.tempAplicMin && c.conformeSaida !== false;
    updateDoc(doc(db, dp), {
      "descarga.fim": agoraHM(), "descarga.tempAplicacao": t, "descarga.trecho": de.trecho,
      "descarga.espessura": de.espessura || "", "descarga.clima": de.clima || "", "descarga.obs": de.obs || "",
      "descarga.registradoPor": perfil.nome,
      status: conforme ? "concluida" : "nao_conforme", ultimaEdicao: edicao(perfil),
    }).catch(() => {});
    setEditar(false);
  };

  const perdaAlta = c.transporte?.perda != null && c.transporte.perda > LIMITES.perdaAlerta;
  const encerrada = c.status === "concluida" || c.status === "nao_conforme";

  return (
    <Cartao style={c.status === "nao_conforme" ? { borderColor: C.red } : null}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 19, color: C.navy }}>{c.placa} <span style={{ color: C.mut, fontWeight: 600, fontSize: 14 }}>NF {c.nf || "—"}</span></div>
        <Chip st={c.status} />
      </div>
      <Linha k="Usina de origem" v={c.usina} />
      <Linha k="Saída" v={`${c.horaSaida} · ${c.tempSaida} °C${c.tonelagem != null ? ` · ${c.tonelagem} t` : ""}`} />
      {c.transporte && <Linha k="Transporte" v={`${fmtMin(c.transporte.minutos)} · perda térmica ${c.transporte.perda ?? "—"} °C`} forte />}
      {perdaAlta && <div style={{ background: C.warnBg, color: C.amber, fontSize: 13, fontWeight: 600, borderRadius: 10, padding: "8px 12px", margin: "8px 0" }}>⚠️ Perda térmica acima de {LIMITES.perdaAlerta} °C no transporte.</div>}

      {c.status === "em_transito" && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
          <div style={{ fontWeight: 800, color: C.ink, fontSize: 14.5, marginBottom: 8 }}>📍 Registrar chegada na obra</div>
          <Campo rotulo="Hora da chegada" type="time" value={ch.hora} onChange={(e) => setCh({ ...ch, hora: e.target.value })} />
          <Btn tom="ok" onClick={confirmarChegada}>✔ Confirmar chegada</Btn>
          <div style={{ fontSize: 12.5, color: C.mut, marginTop: 8 }}>Depois de confirmar, você adianta temperatura, nota, peso e fotos enquanto o caminhão aguarda a descarga.</div>
        </div>
      )}

      {c.status === "no_local" && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
          <div style={{ fontWeight: 800, color: C.ink, fontSize: 14.5, marginBottom: 2 }}>🕓 Na obra · chegou {c.chegada?.hora}</div>
          <div style={{ fontSize: 12.5, color: C.mut, marginBottom: 10 }}>Aguardando descarga — adiante os dados (tudo salva sozinho na nuvem):</div>
          <Campo rotulo="Temp. de chegada" sufixo="°C" inputMode="decimal" value={ch.temp} onChange={(e) => setCh({ ...ch, temp: e.target.value })} onBlur={(e) => salvarTempChegada(e.target.value)} />
          {camposNotaPeso}
          <BotaoFoto obraNome={c.obraNome} docPath={dp} campo="chegada.fotos" legenda="Chegada na obra" rotulo="📷 Foto da carga" />
          <Miniaturas fotos={c.chegada?.fotos} />
          <div style={{ height: 10 }} />
          <Btn onClick={iniciarDescarga}>▶ Iniciar descarga</Btn>
        </div>
      )}

      {(c.status === "descarregando" || (encerrada && editar)) && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
          <div style={{ fontWeight: 800, color: C.ink, fontSize: 14.5, marginBottom: 8 }}>⬇️ Descarga e aplicação {c.descarga?.inicio ? `· início ${c.descarga.inicio}` : ""}</div>
          {camposNotaPeso}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Campo rotulo="Temp. na aplicação *" sufixo="°C" inputMode="decimal" value={de.tempAplicacao} onChange={(e) => setDe({ ...de, tempAplicacao: e.target.value })} onBlur={(e) => salvarCampo("descarga.tempAplicacao", num(e.target.value) ?? "")} />
            <Campo rotulo="Espessura solta (gabarito)" sufixo="cm" inputMode="decimal" value={de.espessura} onChange={(e) => setDe({ ...de, espessura: e.target.value })} onBlur={(e) => salvarCampo("descarga.espessura", e.target.value)} />
          </div>
          <Campo rotulo="Trecho / estaca *" value={de.trecho} onChange={(e) => setDe({ ...de, trecho: e.target.value })} onBlur={(e) => salvarCampo("descarga.trecho", e.target.value)} placeholder="Ex.: Táxi F — Trecho 7 LE" />
          <Sel rotulo="Condição climática" value={de.clima} onChange={(e) => { setDe({ ...de, clima: e.target.value }); salvarCampo("descarga.clima", e.target.value); }}>
            <option value="">—</option>
            {["Ensolarado", "Parcialmente nublado", "Nublado", "Garoa", "Chuva"].map((o) => <option key={o}>{o}</option>)}
          </Sel>
          <Campo rotulo="Observações" value={de.obs} onChange={(e) => setDe({ ...de, obs: e.target.value })} onBlur={(e) => salvarCampo("descarga.obs", e.target.value)} placeholder="Ocorrências, segregação, recusa…" />
          {num(de.tempAplicacao) != null && num(de.tempAplicacao) < LIMITES.tempAplicMin &&
            <div style={{ background: C.redBg, color: C.red, fontSize: 13, fontWeight: 600, borderRadius: 10, padding: "9px 12px", marginBottom: 10 }}>⚠️ Abaixo de {LIMITES.tempAplicMin} °C — carga será marcada como NÃO CONFORME.</div>}
          <BotaoFoto obraNome={c.obraNome} docPath={dp} campo="descarga.fotos" legenda="Aplicação na pista" rotulo="📷 Fotos da aplicação" />
          <Miniaturas fotos={c.descarga?.fotos} />
          <div style={{ height: 10 }} />
          <Btn tom="ok" onClick={finalizar}>✔ Finalizar descarga</Btn>
        </div>
      )}

      {encerrada && !editar && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
          <Linha k="Chegada" v={`${c.chegada?.hora || "—"} · ${c.chegada?.temp ?? "—"} °C`} />
          <Linha k="Descarga" v={`${c.descarga?.inicio || "—"} → ${c.descarga?.fim || "—"}`} />
          <Linha k="Aplicação" v={`${c.descarga?.tempAplicacao ?? "—"} °C · ${c.descarga?.trecho || "—"}`} />
          <Linha k="Nota · peso" v={`NF ${c.nf || "—"} · ${c.tonelagem ?? "—"} t`} />
          {c.descarga?.espessura && <Linha k="Espessura solta" v={`${c.descarga.espessura} cm`} />}
          <Miniaturas fotos={[...(c.chegada?.fotos || []), ...(c.descarga?.fotos || [])]} />
          <button onClick={() => setEditar(true)} style={{ background: "none", border: "none", color: C.blue, fontWeight: 700, fontSize: 13, marginTop: 8, cursor: "pointer", padding: 0 }}>✏️ Corrigir dados</button>
        </div>
      )}
    </Cartao>
  );
}

// ----------------------------------------------------------------------------
// Fechamento do dia na obra: retorno de caminhões, ensaios de pista,
// amostra para laboratório e fotos gerais — com salvamento automático.
// ----------------------------------------------------------------------------
function ObraFechamento({ perfil, obra }) {
  const dataRef = hojeISO();
  const fid = `${obra.id}_${dataRef}`;
  const dp = `fechamentos/${fid}`;
  const [f, setF] = useState(null);
  const [fotosNuvem, setFotosNuvem] = useState([]);
  const [fotosImprim, setFotosImprim] = useState([]);
  const [formularios, setFormularios] = useState(false);
  const [aplic, setAplic] = useState(null);
  const [carregandoRel, setCarregandoRel] = useState(false);
  const abrirAplicacao = async () => {
    setCarregandoRel(true);
    try {
      const [cs, fs] = await Promise.all([
        getDocs(query(collection(db, "cargas"), where("obraId", "==", obra.id))),
        getDocs(query(collection(db, "fechamentos"), where("obraId", "==", obra.id))),
      ]);
      setAplic({ obra, cargas: cs.docs.map((x) => ({ id: x.id, ...x.data() })), fechs: fs.docs.map((x) => ({ id: x.id, ...x.data() })) });
    } catch { alert("Não foi possível carregar os dados da obra. Verifique a internet."); }
    setCarregandoRel(false);
  };
  const pronto = useRef(false);

  // Carrega (ou cria) o fechamento do dia e escuta as fotos em tempo real
  useEffect(() => {
    pronto.current = false;
    const dref = doc(db, "fechamentos", fid);
    setDoc(dref, { obraId: obra.id, obraNome: obra.nome, dataRef, criadoEm: agoraISO() }, { merge: true }).catch(() => {});
    const un = onSnapshot(dref, (s) => {
      const d = s.data() || {};
      setFotosNuvem(d.fotos || []);
      setFotosImprim(d.fotosImprimacao || []);
      if (!pronto.current) {
        setF({
          retorno: d.retorno || "", caminhoesRetorno: d.caminhoesRetorno || "",
          ensaios: d.ensaios?.length ? d.ensaios : [{ estaca: "", gc: "", esp: "", dens: "" }],
          amostras: d.amostras?.length ? d.amostras : [{ ident: "", placa: "", nf: "", trecho: "" }],
          imprimacao: d.imprimacao || [], imprimCfg: d.imprimCfg || { alvo: "0,8", tol: "0,2", area: "0,09" },
          obs: d.obs || "", fechado: !!d.fechado,
        });
        pronto.current = true;
      } else if (typeof d.fechado === "boolean") {
        setF((v) => (v ? { ...v, fechado: d.fechado } : v));
      }
    });
    return un;
  }, [fid]);

  // Salvamento automático na nuvem (debounce de 900 ms)
  useEffect(() => {
    if (!pronto.current || !f) return;
    const t = setTimeout(() => {
      setDoc(doc(db, "fechamentos", fid), {
        retorno: f.retorno, caminhoesRetorno: f.caminhoesRetorno,
        ensaios: f.ensaios, amostras: f.amostras,
        imprimacao: f.imprimacao, imprimCfg: f.imprimCfg, obs: f.obs,
        ultimaEdicao: edicao(perfil),
      }, { merge: true }).catch(() => {});
    }, 900);
    return () => clearTimeout(t);
  }, [JSON.stringify(f)]);

  if (!f) return <Cartao><div style={{ color: C.mut, textAlign: "center" }}>Carregando…</div></Cartao>;

  const mudaLista = (lista, i, k, v) => setF((s) => ({ ...s, [lista]: s[lista].map((r, j) => (j === i ? { ...r, [k]: v } : r)) }));
  const addLinha = (lista, vazio) => setF((s) => ({ ...s, [lista]: [...s[lista], vazio] }));
  const rmLinha = (lista, i) => setF((s) => ({ ...s, [lista]: s[lista].filter((_, j) => j !== i) }));

  const fechar = () => {
    if (!f.retorno) return alert("Informe se haverá retorno de caminhões.");
    setDoc(doc(db, "fechamentos", fid), { fechado: true, fechadoPor: perfil.nome, fechadoEm: agoraISO() }, { merge: true }).catch(() => {});
  };

  const mini = { fontSize: 11.5, fontWeight: 600, color: C.mut, display: "block", marginBottom: 3 };
  const inp = { width: "100%", boxSizing: "border-box", fontFamily: F.body, fontSize: 15, padding: "9px 10px", borderRadius: 9, border: `1.5px solid ${C.line}`, WebkitAppearance: "none" };

  return (
    <>
      <Titulo sub={`${obra.nome} · ${fmtBR(dataRef)} · salvamento automático na nuvem`}>Fechamento do dia</Titulo>

      {f.fechado && (
        <Cartao style={{ background: C.okBg, borderColor: "#BBE6C8" }}>
          <div style={{ color: C.ok, fontWeight: 800 }}>✅ Dia fechado e enviado à coordenação.</div>
          <button onClick={() => setDoc(doc(db, "fechamentos", fid), { fechado: false }, { merge: true })} style={{ background: "none", border: "none", color: C.blue, fontWeight: 700, fontSize: 13, marginTop: 6, cursor: "pointer", padding: 0 }}>Reabrir para correção</button>
        </Cartao>
      )}

      <Cartao>
        <div style={{ fontWeight: 800, fontSize: 15.5, color: C.navy, marginBottom: 10 }}>🚚 Programação de retorno à usina</div>
        <Sel rotulo="Haverá retorno de caminhões para novo carregamento?" value={f.retorno} onChange={(e) => setF({ ...f, retorno: e.target.value })}>
          <option value="">—</option><option value="sim">Sim</option><option value="nao">Não — encerrar o dia</option>
        </Sel>
        {f.retorno === "sim" && <Campo rotulo="Quantos caminhões faltam para concluir o dia?" inputMode="numeric" value={f.caminhoesRetorno} onChange={(e) => setF({ ...f, caminhoesRetorno: e.target.value })} placeholder="Ex.: 3" />}
        <div style={{ fontSize: 12.5, color: C.mut }}>A usina e a coordenação veem essa informação em tempo real.</div>
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, fontSize: 15.5, color: C.navy, marginBottom: 4 }}>🧪 Ensaios de pista</div>
        <div style={{ fontSize: 12.5, color: C.mut, marginBottom: 10 }}>Grau de compactação mínimo {LIMITES.gcMin}% (ref. Marshall) — DNIT 031/2006-ES.</div>
        {f.ensaios.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr auto", gap: 7, marginBottom: 8, alignItems: "end" }}>
            <span><span style={mini}>Estaca/local</span><input style={inp} value={r.estaca} onChange={(e) => mudaLista("ensaios", i, "estaca", e.target.value)} /></span>
            <span><span style={mini}>GC (%)</span><input style={{ ...inp, ...(num(r.gc) != null && num(r.gc) < LIMITES.gcMin ? { borderColor: C.red, color: C.red, fontWeight: 700 } : {}) }} inputMode="decimal" value={r.gc} onChange={(e) => mudaLista("ensaios", i, "gc", e.target.value)} /></span>
            <span><span style={mini}>Esp. (cm)</span><input style={inp} inputMode="decimal" value={r.esp} onChange={(e) => mudaLista("ensaios", i, "esp", e.target.value)} /></span>
            <span><span style={mini}>Dens. (g/cm³)</span><input style={inp} inputMode="decimal" value={r.dens} onChange={(e) => mudaLista("ensaios", i, "dens", e.target.value)} /></span>
            <button onClick={() => rmLinha("ensaios", i)} style={{ border: "none", background: C.grayBg, color: C.red, borderRadius: 9, width: 34, height: 38, fontWeight: 800, cursor: "pointer" }}>×</button>
          </div>
        ))}
        <Btn tom="claro" onClick={() => addLinha("ensaios", { estaca: "", gc: "", esp: "", dens: "" })} style={{ padding: "10px" }}>+ Adicionar ensaio</Btn>
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, fontSize: 15.5, color: C.navy, marginBottom: 4 }}>🔬 Amostras para o laboratório</div>
        <div style={{ fontSize: 12.5, color: C.mut, marginBottom: 10 }}>Identifique como na etiqueta de campo: placa, data, pista/trecho e NF. Fotografe a amostra nas fotos do dia.</div>
        {f.amostras.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 10, paddingBottom: 10, borderBottom: `1px dashed ${C.line}` }}>
            <span><span style={mini}>Identificação</span><input style={inp} value={r.ident} onChange={(e) => mudaLista("amostras", i, "ident", e.target.value)} placeholder="AM-01" /></span>
            <span><span style={mini}>Placa</span><input style={inp} value={r.placa} onChange={(e) => mudaLista("amostras", i, "placa", e.target.value)} /></span>
            <span><span style={mini}>NF</span><input style={inp} value={r.nf} onChange={(e) => mudaLista("amostras", i, "nf", e.target.value)} /></span>
            <span style={{ display: "flex", gap: 7 }}>
              <span style={{ flex: 1 }}><span style={mini}>Pista/trecho</span><input style={inp} value={r.trecho} onChange={(e) => mudaLista("amostras", i, "trecho", e.target.value)} /></span>
              <button onClick={() => rmLinha("amostras", i)} style={{ border: "none", background: C.grayBg, color: C.red, borderRadius: 9, width: 34, alignSelf: "end", height: 38, fontWeight: 800, cursor: "pointer" }}>×</button>
            </span>
          </div>
        ))}
        <Btn tom="claro" onClick={() => addLinha("amostras", { ident: "", placa: "", nf: "", trecho: "" })} style={{ padding: "10px" }}>+ Adicionar amostra</Btn>
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, fontSize: 15.5, color: C.navy, marginBottom: 4 }}>🛢️ Imprimação / pintura de ligação — bandeja</div>
        <div style={{ fontSize: 12.5, color: C.mut, marginBottom: 10 }}>DNIT 144/2014 · taxa = (peso 02 − peso 01) ÷ área da bandeja. Cálculo e conformidade automáticos.</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 10 }}>
          <span><span style={mini}>Taxa de projeto (l/m²)</span><input style={inp} inputMode="decimal" value={f.imprimCfg.alvo} onChange={(e) => setF({ ...f, imprimCfg: { ...f.imprimCfg, alvo: e.target.value } })} /></span>
          <span><span style={mini}>Tolerância ±</span><input style={inp} inputMode="decimal" value={f.imprimCfg.tol} onChange={(e) => setF({ ...f, imprimCfg: { ...f.imprimCfg, tol: e.target.value } })} /></span>
          <span><span style={mini}>Área bandeja (m²)</span><input style={inp} inputMode="decimal" value={f.imprimCfg.area} onChange={(e) => setF({ ...f, imprimCfg: { ...f.imprimCfg, area: e.target.value } })} /></span>
        </div>
        {f.imprimacao.map((r, i) => {
          const cf = calcImprim(r, f.imprimCfg);
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr auto", gap: 7, marginBottom: 8, alignItems: "end" }}>
              <span><span style={mini}>Trecho</span><input style={inp} value={r.trecho} onChange={(e) => mudaLista("imprimacao", i, "trecho", e.target.value)} placeholder="Trecho 8 LD" /></span>
              <span><span style={mini}>Peso 01 (kg)</span><input style={inp} inputMode="decimal" value={r.p1} onChange={(e) => mudaLista("imprimacao", i, "p1", e.target.value)} /></span>
              <span><span style={mini}>Peso 02 (kg)</span><input style={inp} inputMode="decimal" value={r.p2} onChange={(e) => mudaLista("imprimacao", i, "p2", e.target.value)} /></span>
              <span style={{ fontSize: 13, fontWeight: 800, paddingBottom: 10, color: cf ? (cf.sit === "conforme" ? C.ok : C.red) : C.mut }}>{cf ? `${cf.taxa.toFixed(2)} l/m²` : "—"}</span>
              <button onClick={() => rmLinha("imprimacao", i)} style={{ border: "none", background: C.grayBg, color: C.red, borderRadius: 9, width: 34, height: 38, fontWeight: 800, cursor: "pointer" }}>×</button>
            </div>
          );
        })}
        <Btn tom="claro" onClick={() => addLinha("imprimacao", { trecho: "", p1: "", p2: "" })} style={{ padding: "10px" }}>+ Adicionar medição da bandeja</Btn>
        <div style={{ height: 10 }} />
        <BotaoFoto obraNome={obra.nome} docPath={dp} campo="fotosImprimacao" legenda="Imprimação (bandeja)" rotulo="📷 Fotos da bandeja" />
        <Miniaturas fotos={fotosImprim} />
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, fontSize: 15.5, color: C.navy, marginBottom: 10 }}>📷 Fotos do dia (pista, ensaios, amostras)</div>
        <BotaoFoto obraNome={obra.nome} docPath={dp} campo="fotos" legenda="Fechamento do dia" />
        <Miniaturas fotos={fotosNuvem} />
      </Cartao>

      <Cartao>
        <Campo rotulo="Observações gerais do dia" value={f.obs} onChange={(e) => setF({ ...f, obs: e.target.value })} placeholder="Paralisações, clima, intercorrências…" />
        <div style={{ display: "grid", gap: 8 }}>
          <Btn tom="claro" onClick={() => setFormularios(true)}>📄 Formulários de campo (CBUQ + imprimação)</Btn>
          <Btn onClick={abrirAplicacao} disabled={carregandoRel}>{carregandoRel ? "Carregando dados da obra…" : "📐 Relatório técnico de aplicação (obra completa)"}</Btn>
          <Btn tom="red" onClick={fechar} disabled={f.fechado}>{f.fechado ? "Dia já fechado" : "🔒 Fechar o dia e enviar à coordenação"}</Btn>
        </div>
      </Cartao>
      {formularios && <FormulariosCampo obra={obra} dataRef={dataRef} fechar={() => setFormularios(false)} />}
      {aplic && <RelatorioAplicacao {...aplic} fechar={() => setAplic(null)} />}
    </>
  );
}

// ============================================================================
// PAPEL: COORDENADOR GERAL
// ============================================================================
function TelaCoordenador({ perfil, aba }) {
  if (aba === "painel") return <CoordPainel />;
  if (aba === "obras") return <CoordObras perfil={perfil} />;
  if (aba === "equipe") return <CoordEquipe perfil={perfil} />;
  return <CoordRelatorios />;
}

function CoordPainel() {
  const cargas = useCargasDia(hojeISO());
  const obras = useObras(false);
  const [fechs, setFechs] = useState([]);
  useEffect(() => onSnapshot(query(collection(db, "fechamentos"), where("dataRef", "==", hojeISO())), (s) =>
    setFechs(s.docs.map((d) => ({ id: d.id, ...d.data() })))), []);

  const ton = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const transito = cargas.filter((c) => c.status === "em_transito");
  const concl = cargas.filter((c) => c.status === "concluida" || c.status === "nao_conforme");
  const ncs = cargas.filter((c) => c.status === "nao_conforme" || c.conformeSaida === false);
  const perdas = cargas.map((c) => c.transporte?.perda).filter((v) => v != null);
  const tempos = cargas.map((c) => c.transporte?.minutos).filter((v) => v != null);
  const med = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const conf = concl.length ? Math.round((concl.filter((c) => c.status === "concluida").length / concl.length) * 100) : null;

  const Kpi = ({ v, r, cor }) => (
    <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 8px", textAlign: "center" }}>
      <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 24, color: cor || C.navy }}>{v}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: C.mut, marginTop: 2 }}>{r}</div>
    </div>
  );

  const [tv, setTv] = useState(false);
  return (
    <>
      <Titulo sub={`Panorama de hoje · ${fmtBR(hojeISO())} · atualiza em tempo real`}>Painel geral</Titulo>
      <Btn tom="claro" onClick={() => setTv(true)} style={{ marginBottom: 12 }}>📺 Modo TV — painel executivo ao vivo</Btn>
      {tv && <PainelTV fechar={() => setTv(false)} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 10 }}>
        <Kpi v={`${ton.toFixed(1)} t`} r="Massa aplicada/enviada" />
        <Kpi v={cargas.length} r="Cargas no dia" />
        <Kpi v={transito.length} r="Em trânsito agora" cor={transito.length ? C.amber : C.navy} />
        <Kpi v={conf == null ? "—" : `${conf}%`} r="Conformidade" cor={conf != null && conf < 100 ? C.red : C.ok} />
        <Kpi v={med(perdas) == null ? "—" : `${med(perdas).toFixed(0)} °C`} r="Perda térmica média" />
        <Kpi v={med(tempos) == null ? "—" : fmtMin(Math.round(med(tempos)))} r="Tempo médio usina→obra" />
      </div>

      {ncs.length > 0 && (
        <Cartao style={{ borderColor: C.red, background: C.redBg }}>
          <div style={{ fontWeight: 800, color: C.red, marginBottom: 6 }}>⚠️ Alertas de não conformidade</div>
          {ncs.map((c) => <div key={c.id} style={{ fontSize: 13.5, color: C.ink, padding: "3px 0" }}>• {c.obraNome} — {c.placa}: {c.conformeSaida === false ? "temperatura fora da faixa na saída" : `aplicação a ${c.descarga?.tempAplicacao} °C (mín. ${LIMITES.tempAplicMin} °C)`}</div>)}
        </Cartao>
      )}

      {transito.length > 0 && (
        <Cartao>
          <div style={{ fontWeight: 800, color: C.navy, marginBottom: 6 }}>🚚 Em trânsito agora</div>
          {transito.map((c) => <Linha key={c.id} k={`${c.placa} → ${c.obraNome}`} v={`saiu ${c.horaSaida} · ${c.tempSaida} °C${c.tonelagem != null ? ` · ${c.tonelagem} t` : ""}`} />)}
        </Cartao>
      )}

      <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 16, color: C.navy, margin: "14px 2px 8px", textTransform: "uppercase" }}>Por obra</div>
      {obras.filter((o) => o.status === "ativa").map((o) => {
        const cs = cargas.filter((c) => c.obraId === o.id);
        const fe = fechs.find((x) => x.obraId === o.id);
        const t = cs.reduce((s, c) => s + (c.tonelagem || 0), 0);
        return (
          <Cartao key={o.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 800, color: C.navy, fontSize: 15.5 }}>{o.nome}</div>
              {fe?.fechado ? <span style={{ fontSize: 11.5, fontWeight: 700, color: C.ok, background: C.okBg, padding: "3px 9px", borderRadius: 99 }}>Dia fechado</span>
                : <span style={{ fontSize: 11.5, fontWeight: 700, color: C.amber, background: C.warnBg, padding: "3px 9px", borderRadius: 99 }}>Em execução</span>}
            </div>
            <Linha k="Cargas · tonelagem" v={`${cs.length} · ${t.toFixed(1)} t`} />
            {fe?.retorno && <Linha k="Retorno de caminhões" v={fe.retorno === "sim" ? `Sim — faltam ${fe.caminhoesRetorno || "?"}` : "Não, dia encerrado"} forte />}
            {cs.some((c) => c.ultimaEdicao) && <Linha k="Último registro" v={cs.map((c) => c.ultimaEdicao).filter(Boolean).sort((a, b) => (a.em < b.em ? 1 : -1))[0]?.por} />}
          </Cartao>
        );
      })}
      {!obras.filter((o) => o.status === "ativa").length && <Cartao><div style={{ color: C.mut, textAlign: "center" }}>Nenhuma obra ativa. Cadastre em “Obras”.</div></Cartao>}
    </>
  );
}

// ----------------------------------------------------------------------------
// Coordenador — Obras (cadastrar, concluir e resumo geral da execução)
// ----------------------------------------------------------------------------
function CoordObras({ perfil }) {
  const obras = useObras(false);
  const [f, setF] = useState({ nome: "", contratante: "", local: "", espessuraProjeto: "", faixa: "", freqTon: "", freqCargas: "" });
  const [msg, setMsg] = useState("");
  const [resumo, setResumo] = useState(null);
  const [aplic, setAplic] = useState(null);
  const m = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const criar = () => {
    if (!f.nome.trim()) return setMsg("Informe o nome da obra.");
    setDoc(doc(collection(db, "obras")), {
      nome: f.nome.trim(), contratante: f.contratante.trim(), local: f.local.trim(),
      espessuraProjeto: f.espessuraProjeto, faixa: f.faixa,
      freqTon: f.freqTon, freqCargas: f.freqCargas, status: "ativa",
      dataInicio: hojeISO(), dataConclusao: "", criadoPor: perfil.nome, criadoEm: agoraISO(),
    }).catch(() => {});
    setF({ nome: "", contratante: "", local: "", espessuraProjeto: "", faixa: "", freqTon: "", freqCargas: "" }); setMsg("");
  };
  const concluir = async (o) => {
    if (!confirm(`Concluir a obra "${o.nome}"? Ela sai da lista dos técnicos e o resumo geral fica disponível.`)) return;
    await updateDoc(doc(db, "obras", o.id), { status: "concluida", dataConclusao: hojeISO() });
  };
  const abrirDados = async (o, alvo) => {
    const [cs, fs] = await Promise.all([
      getDocs(query(collection(db, "cargas"), where("obraId", "==", o.id))),
      getDocs(query(collection(db, "fechamentos"), where("obraId", "==", o.id))),
    ]);
    alvo({ obra: o, cargas: cs.docs.map((d) => ({ id: d.id, ...d.data() })), fechs: fs.docs.map((d) => ({ id: d.id, ...d.data() })) });
  };
  const abrirResumo = async (o) => {
    const [cs, fs] = await Promise.all([
      getDocs(query(collection(db, "cargas"), where("obraId", "==", o.id))),
      getDocs(query(collection(db, "fechamentos"), where("obraId", "==", o.id))),
    ]);
    setResumo({ obra: o, cargas: cs.docs.map((d) => ({ id: d.id, ...d.data() })), fechs: fs.docs.map((d) => ({ id: d.id, ...d.data() })) });
  };

  return (
    <>
      <Titulo sub="Cadastre as frentes de trabalho — os técnicos selecionam a obra no app.">Obras</Titulo>
      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 10 }}>➕ Nova obra</div>
        <Campo rotulo="Nome da obra *" value={f.nome} onChange={m("nome")} placeholder="Ex.: EMBRAER — Gavião Peixoto · Táxi F" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Campo rotulo="Contratante" value={f.contratante} onChange={m("contratante")} placeholder="Ex.: EMBRAER" />
          <Campo rotulo="Local / município" value={f.local} onChange={m("local")} placeholder="Gavião Peixoto — SP" />
          <Campo rotulo="Espessura de projeto" sufixo="cm" inputMode="decimal" value={f.espessuraProjeto} onChange={m("espessuraProjeto")} placeholder="7" />
          <Sel rotulo="Faixa granulométrica" value={f.faixa} onChange={m("faixa")}>
            <option value="">—</option><option>Faixa A</option><option>Faixa B</option><option>Faixa C</option>
          </Sel>
          <Campo rotulo="Frequência de ensaio (toneladas)" sufixo="t" inputMode="numeric" value={f.freqTon} onChange={m("freqTon")} placeholder="Ex.: 500" />
          <Campo rotulo="Frequência de ensaio (cargas)" inputMode="numeric" value={f.freqCargas} onChange={m("freqCargas")} placeholder="Ex.: 5" />
        </div>
        {msg && <div style={{ color: C.red, fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>{msg}</div>}
        <Btn onClick={criar}>Cadastrar obra</Btn>
      </Cartao>

      {obras.map((o) => (
        <Cartao key={o.id} style={o.status === "concluida" ? { opacity: 0.85 } : null}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontWeight: 800, color: C.navy, fontSize: 15.5 }}>{o.nome}</div>
            <span style={{ fontSize: 11.5, fontWeight: 700, padding: "3px 9px", borderRadius: 99, color: o.status === "ativa" ? C.ok : C.mut, background: o.status === "ativa" ? C.okBg : C.grayBg }}>
              {o.status === "ativa" ? "Ativa" : "Concluída"}
            </span>
          </div>
          <Linha k="Contratante · local" v={`${o.contratante || "—"} · ${o.local || "—"}`} />
          <Linha k="Período" v={`${fmtBR(o.dataInicio)} → ${o.dataConclusao ? fmtBR(o.dataConclusao) : "em andamento"}`} />
          {o.espessuraProjeto && <Linha k="Projeto" v={`${o.espessuraProjeto} cm ${o.faixa ? `· ${o.faixa}` : ""}`} />}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Btn tom="claro" cheio={false} onClick={() => abrirResumo(o)} style={{ flex: 1, padding: "10px" }}>📄 Resumo geral</Btn>
            <Btn cheio={false} onClick={() => abrirDados(o, setAplic)} style={{ flex: 1, padding: "10px" }}>📐 Relatório de aplicação</Btn>
            {o.status === "ativa"
              ? <Btn tom="red" cheio={false} onClick={() => concluir(o)} style={{ flex: 1, padding: "10px" }}>🏁 Concluir obra</Btn>
              : <Btn tom="claro" cheio={false} onClick={() => updateDoc(doc(db, "obras", o.id), { status: "ativa", dataConclusao: "" })} style={{ flex: 1, padding: "10px" }}>Reativar</Btn>}
          </div>
        </Cartao>
      ))}
      {resumo && <ResumoObra {...resumo} fechar={() => setResumo(null)} />}
      {aplic && <RelatorioAplicacao {...aplic} fechar={() => setAplic(null)} />}
    </>
  );
}

// ----------------------------------------------------------------------------
// Coordenador — Equipe (login/senha por funcionário, papéis e realocação)
// ----------------------------------------------------------------------------
function CoordEquipe({ perfil }) {
  const obras = useObras();
  const [usuarios, setUsuarios] = useState([]);
  const [f, setF] = useState({ nome: "", email: "", senha: "", papel: "obra", obraId: "" });
  const [msg, setMsg] = useState("");
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => onSnapshot(collection(db, "usuarios"), (s) => setUsuarios(s.docs.map((d) => ({ uid: d.id, ...d.data() })))), []);
  const m = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const criar = async () => {
    setMsg("");
    if (!f.nome.trim() || !f.email.trim() || f.senha.length < 6) return setMsg("Nome, e-mail e senha (6+) são obrigatórios.");
    setOcupado(true);
    try {
      // Cria o usuário numa instância secundária p/ não derrubar a sessão do coordenador
      const sec = getApps().find((a) => a.name === "sec") || initializeApp(firebaseConfig, "sec");
      const sAuth = getAuth(sec);
      const cred = await createUserWithEmailAndPassword(sAuth, f.email.trim(), f.senha);
      await setDoc(doc(db, "usuarios", cred.user.uid), {
        nome: f.nome.trim(), email: f.email.trim(), papel: f.papel, obraId: f.obraId || "",
        ativo: true, criadoEm: agoraISO(), criadoPor: perfil.nome,
      });
      await signOut(sAuth);
      setF({ nome: "", email: "", senha: "", papel: "obra", obraId: "" });
      setMsg("ok");
    } catch (e) { setMsg(e.code === "auth/email-already-in-use" ? "E-mail já cadastrado." : "Falha ao criar (verifique a internet)."); }
    setOcupado(false);
  };

  const excluir = async (u) => {
    if (!confirm(`Excluir o acesso de ${u.nome}?\n\nA pessoa perde o login imediatamente e some da lista da equipe. Os registros já feitos permanecem no sistema, assinados com o nome dela.\n\nEssa ação não pode ser desfeita.`)) return;
    await deleteDoc(doc(db, "usuarios", u.uid));
  };

  const rotPapel = { coordenador: "Coordenador", usina: "Técnico de usina", obra: "Técnico de obra", ambos: "Técnico de usina + obra", diretoria: "Diretoria" };
  return (
    <>
      <Titulo sub="Cada funcionário tem login próprio — todo registro fica assinado com nome e horário.">Equipe</Titulo>
      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 10 }}>➕ Novo acesso</div>
        <Campo rotulo="Nome completo *" value={f.nome} onChange={m("nome")} />
        <Campo rotulo="E-mail *" type="email" autoCapitalize="none" value={f.email} onChange={m("email")} />
        <Campo rotulo="Senha provisória * (6+ caracteres)" value={f.senha} onChange={m("senha")} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Sel rotulo="Papel" value={f.papel} onChange={m("papel")}>
            <option value="obra">Técnico de obra</option>
            <option value="usina">Técnico de usina</option>
            <option value="ambos">Técnico de usina + obra</option>
            <option value="diretoria">Diretoria (somente visualizar)</option>
            <option value="coordenador">Coordenador</option>
          </Sel>
          <Sel rotulo="Obra padrão (opcional)" value={f.obraId} onChange={m("obraId")}>
            <option value="">—</option>
            {obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
          </Sel>
        </div>
        {msg === "ok" && <div style={{ color: C.ok, fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>✅ Acesso criado. Envie e-mail e senha ao funcionário.</div>}
        {msg && msg !== "ok" && <div style={{ color: C.red, fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>{msg}</div>}
        <Btn onClick={criar} disabled={ocupado}>{ocupado ? "Criando…" : "Criar acesso"}</Btn>
      </Cartao>

      {usuarios.map((u) => (
        <Cartao key={u.uid} style={!u.ativo ? { opacity: 0.6 } : null}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 800, color: C.navy }}>{u.nome} {u.uid === perfil.uid && <span style={{ color: C.mut, fontWeight: 600, fontSize: 12 }}>(você)</span>}</div>
              <div style={{ fontSize: 12.5, color: C.mut }}>{rotPapel[u.papel] || u.papel} · {u.email}</div>
            </div>
            {u.uid !== perfil.uid && (
              <div style={{ display: "flex", gap: 6 }}>
                <Btn tom={u.ativo ? "red" : "ok"} cheio={false} style={{ padding: "8px 12px", fontSize: 13 }}
                  onClick={() => updateDoc(doc(db, "usuarios", u.uid), { ativo: !u.ativo })}>
                  {u.ativo ? "Desativar" : "Reativar"}
                </Btn>
                <Btn tom="claro" cheio={false} style={{ padding: "8px 12px", fontSize: 13, color: C.red, borderColor: "#F3C2C2" }}
                  onClick={() => excluir(u)}>🗑️ Excluir</Btn>
              </div>
            )}
          </div>
          {u.papel !== "coordenador" && (
            <div style={{ marginTop: 8 }}>
              <Sel rotulo="Realocar para a obra" value={u.obraId || ""} onChange={(e) => updateDoc(doc(db, "usuarios", u.uid), { obraId: e.target.value })} style={{ padding: "9px 10px", fontSize: 14 }}>
                <option value="">— sem obra padrão —</option>
                {obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
              </Sel>
            </div>
          )}
        </Cartao>
      ))}
    </>
  );
}

// ----------------------------------------------------------------------------
// Coordenador — Relatórios (diário consolidado por obra/data)
// ----------------------------------------------------------------------------
function CoordRelatorios() {
  const obras = useObras(false);
  const [obraId, setObraId] = useState("");
  const [data, setData] = useState(hojeISO());
  const [rel, setRel] = useState(null);
  const [carta, setCarta] = useState(null);
  const [forms, setForms] = useState(null);
  const [msg, setMsg] = useState("");

  const gerar = async () => {
    setMsg("");
    const obra = obras.find((o) => o.id === obraId);
    if (!obra) return setMsg("Selecione a obra.");
    const cs = await getDocs(query(collection(db, "cargas"), where("obraId", "==", obraId), where("dataRef", "==", data)));
    const fe = await getDoc(doc(db, "fechamentos", `${obraId}_${data}`));
    const cargas = cs.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!cargas.length && !fe.exists()) return setMsg("Sem registros nessa obra/data.");
    setRel({ obra, dataRef: data, cargas, fech: fe.exists() ? fe.data() : null });
  };

  return (
    <>
      <Titulo sub="Relatório diário consolidado: usina + transporte + pista + laboratório.">Relatórios</Titulo>
      <Cartao>
        <Sel rotulo="Obra" value={obraId} onChange={(e) => setObraId(e.target.value)}>
          <option value="">Selecione…</option>
          {obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
        </Sel>
        <Campo rotulo="Data" type="date" value={data} onChange={(e) => setData(e.target.value)} />
        {msg && <div style={{ color: C.red, fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>{msg}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Btn onClick={gerar}>📄 Relatório do dia</Btn>
          <Btn tom="red" onClick={() => { const o = obras.find((x) => x.id === obraId); o ? setCarta(o) : setMsg("Selecione a obra."); }}>📈 Carta de controle</Btn>
        </div>
        <div style={{ height: 8 }} />
        <Btn tom="claro" onClick={() => { const o = obras.find((x) => x.id === obraId); o ? setForms(o) : setMsg("Selecione a obra."); }}>🧾 Formulários de campo (CBUQ + imprimação)</Btn>
      </Cartao>
      {rel && <RelatorioDiario {...rel} fechar={() => setRel(null)} />}
      {carta && <CartaControle obra={carta} fechar={() => setCarta(null)} />}
      {forms && <FormulariosCampo obra={forms} dataRef={data} fechar={() => setForms(null)} />}
    </>
  );
}

// ============================================================================
// MÓDULO DE ENSAIOS DA USINA (preserva e amplia o app atual)
// Teor de ligante · Granulometria · Projeto de mistura · Equipamentos
// ============================================================================
// Faixas granulométricas DNIT (% passante) — pré-preenchimento do projeto.
// A referência normativa é CONFIGURÁVEL por projeto (padrão: DNIT 031/2024-ES).
const NORMAS = [
  "DNIT 031/2024-ES (Errata 1 — 27/11/2025)",
  "DNIT 031/2006-ES",
  "Especificação contratual / projeto executivo",
];
const METODOS_TEOR = [
  "Rotarex — extração por centrífuga (DNER-ME 053)",
  "Ignição (NBR 16972)",
  "Soxhlet (refluxo)",
];
const FAIXAS_DNIT = {
  "Faixa A": [["1 1/2\"",95,100],["1\"",75,100],["3/4\"",60,90],["3/8\"",35,65],["nº 4",25,50],["nº 10",20,40],["nº 40",10,30],["nº 80",5,20],["nº 200",1,8]],
  "Faixa B": [["1\"",95,100],["3/4\"",80,100],["3/8\"",45,80],["nº 4",28,60],["nº 10",20,45],["nº 40",10,32],["nº 80",8,20],["nº 200",3,8]],
  "Faixa C": [["3/4\"",100,100],["1/2\"",80,100],["3/8\"",70,90],["nº 4",44,72],["nº 10",22,50],["nº 40",8,26],["nº 80",4,16],["nº 200",2,10]],
};
// Faixa de trabalho (tolerância sobre a curva de projeto) por abertura
const tolPeneira = (nome) => (/["]/.test(nome) ? 7 : nome.includes("4") && !nome.includes("40") ? 5 : nome.includes("10") ? 5 : nome.includes("40") ? 5 : nome.includes("80") ? 3 : 2);
const SIT = {
  conforme:     { rot: "Conforme",     cor: C.ok,    bg: C.okBg },
  atencao:      { rot: "Atenção",      cor: C.amber, bg: C.warnBg },
  nao_conforme: { rot: "Não conforme", cor: C.red,   bg: C.redBg },
};
const SeloSit = ({ s }) => {
  const x = SIT[s] || SIT.atencao;
  return <span style={{ fontSize: 11.5, fontWeight: 800, color: x.cor, background: x.bg, padding: "3px 10px", borderRadius: 99 }}>{x.rot}</span>;
};

function useEnsaiosDia(obraId, dataRef) {
  const [l, setL] = useState([]);
  useEffect(() => {
    if (!obraId) return setL([]);
    return onSnapshot(query(collection(db, "ensaios"), where("obraId", "==", obraId), where("dataRef", "==", dataRef)), (s) => {
      const a = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      a.sort((x, y) => (x.criadoEm || "").localeCompare(y.criadoEm || ""));
      setL(a);
    });
  }, [obraId, dataRef]);
  return l;
}
function useProjetos(obraId) {
  const [l, setL] = useState([]);
  useEffect(() => onSnapshot(collection(db, "projetos"), (s) => {
    const a = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    setL(obraId ? a.filter((p) => !p.obraId || p.obraId === obraId) : a);
  }), [obraId]);
  return l;
}
function useEquipamentos() {
  const [l, setL] = useState([]);
  useEffect(() => onSnapshot(collection(db, "equipamentos"), (s) => setL(s.docs.map((d) => ({ id: d.id, ...d.data() })))), []);
  return l;
}
const calibVencida = (eq) => eq?.validade && eq.validade < hojeISO();

// ----------------------------------------------------------------------------
// Cálculos — teor de ligante
// Fórmula: Teor (%) = (Mi − Ma − Mf) ÷ Mi × 100
//   Mi = massa inicial da amostra · Ma = agregado recuperado · Mf = retido no filtro
// ----------------------------------------------------------------------------
function calcTeor(mi, ma, mf, projeto) {
  const Mi = num(mi), Ma = num(ma), Mf = num(mf) || 0;
  if (Mi == null || Ma == null || Mi <= 0) return null;
  if (Ma + Mf >= Mi) return { erro: "Massas incompatíveis: agregado + filtro ≥ massa inicial." };
  const teor = ((Mi - Ma - Mf) / Mi) * 100;
  if (teor <= 0 || teor >= 15) return { erro: "Resultado fora do fisicamente possível — confira as pesagens." };
  const tp = num(projeto?.teorProjeto), tol = num(projeto?.tolTeor) ?? 0.3;
  const desvio = tp != null ? Math.round((teor - tp) * 100) / 100 : null;
  const desvioPct = tp ? Math.round(((teor - tp) / tp) * 1000) / 10 : null;
  let sit = "atencao";
  if (desvio != null) sit = Math.abs(desvio) <= tol ? "conforme" : Math.abs(desvio) <= tol + 0.1 ? "atencao" : "nao_conforme";
  return { teor: Math.round(teor * 100) / 100, desvio, desvioPct, tol, tp, sit,
    memoria: `Teor = (${Mi} − ${Ma}${Mf ? ` − ${Mf}` : ""}) ÷ ${Mi} × 100`, versaoFormula: "TL-v1" };
}

// ----------------------------------------------------------------------------
// Cálculos — granulometria do agregado recuperado
// ----------------------------------------------------------------------------
function calcGran(massaSeca, linhas, fundo) {
  const Ms = num(massaSeca);
  if (Ms == null || Ms <= 0) return null;
  let acum = 0; const out = []; const alertas = [];
  let passanteAnt = 100;
  linhas.forEach((r) => {
    const ret = num(r.massa);
    const pct = ret != null ? (ret / Ms) * 100 : null;
    acum += pct || 0;
    const passante = Math.round((100 - acum) * 10) / 10;
    const proj = num(r.projeto), tol = num(r.tol) ?? tolPeneira(r.nome);
    const li = num(r.limInf), ls = num(r.limSup);
    const apInf = proj != null ? Math.max(li ?? -Infinity, proj - tol) : li;
    const apSup = proj != null ? Math.min(ls ?? Infinity, proj + tol) : ls;
    let sit = null;
    if (ret != null && proj != null) {
      sit = passante >= apInf && passante <= apSup ? "conforme"
        : (li != null && ls != null && passante >= li && passante <= ls) ? "atencao" : "nao_conforme";
    }
    if (r.projeto && ret == null) alertas.push(`Peneira ${r.nome}: projeto informado sem massa retida.`);
    if (passante > passanteAnt + 0.01) alertas.push(`Peneira ${r.nome}: passante maior que o da peneira anterior — sequência incompatível.`);
    passanteAnt = ret != null ? passante : passanteAnt;
    out.push({ ...r, retPct: pct != null ? Math.round(pct * 10) / 10 : null, acum: Math.round(acum * 10) / 10, passante: ret != null ? passante : null, apInf, apSup, tol, sit,
      dif: proj != null && ret != null ? Math.round((passante - proj) * 10) / 10 : null });
  });
  const soma = linhas.reduce((s, r) => s + (num(r.massa) || 0), 0) + (num(fundo) || 0);
  const perda = Math.round(((Ms - soma) / Ms) * 1000) / 10;
  if (Math.abs(perda) > 0.5) alertas.push(`Fechamento de massa: perda de ${perda}% (limite operacional 0,5%).`);
  const vals = linhas.map((r) => num(r.massa)).filter((v) => v != null);
  if (new Set(vals).size < vals.length && vals.length > 2) alertas.push("Há massas retidas duplicadas — confira as pesagens.");
  const sits = out.map((o) => o.sit).filter(Boolean);
  const geral = sits.includes("nao_conforme") ? "nao_conforme" : sits.includes("atencao") ? "atencao" : sits.length ? "conforme" : null;
  return { linhas: out, soma: Math.round(soma * 10) / 10, perda, geral, alertas };
}

// ----------------------------------------------------------------------------
// Projeto de mistura asfáltica (cadastro estruturado, com trava de aprovação)
// ----------------------------------------------------------------------------
function FormProjeto({ perfil, obras, aoFechar, existente }) {
  const [p, setP] = useState(existente || {
    codigo: "", cliente: "", obraId: "", usina: "", tipoMistura: "CBUQ — concreto asfáltico",
    faixa: "Faixa C", tipoLigante: "CAP 50/70", teorProjeto: "", tolTeor: "0.3",
    norma: NORMAS[0], versao: "1", status: "Em elaboração", responsavel: "", obs: "",
    peneiras: FAIXAS_DNIT["Faixa C"].map(([nome, li, ls]) => ({ nome, projeto: "", limInf: li, limSup: ls, tol: tolPeneira(nome) })),
  });
  const travado = existente && existente.status === "Aprovado" && perfil.papel !== "coordenador";
  const m = (k) => (e) => setP({ ...p, [k]: e.target.value });
  const mudarFaixa = (fx) => setP({ ...p, faixa: fx, peneiras: (FAIXAS_DNIT[fx] || []).map(([nome, li, ls]) => ({ nome, projeto: "", limInf: li, limSup: ls, tol: tolPeneira(nome) })) });
  const mp = (i, k, v) => setP({ ...p, peneiras: p.peneiras.map((r, j) => (j === i ? { ...r, [k]: v } : r)) });

  const salvar = async () => {
    if (!p.codigo.trim() || !num(p.teorProjeto)) return alert("Informe ao menos o código e o teor de projeto.");
    const dados = { ...p, teorProjeto: num(p.teorProjeto), tolTeor: num(p.tolTeor) ?? 0.3, ultimaEdicao: edicao(perfil) };
    if (existente?.id) await updateDoc(doc(db, "projetos", existente.id), dados);
    else await addDoc(collection(db, "projetos"), { ...dados, criadoEm: agoraISO(), criadoPor: perfil.nome });
    aoFechar();
  };
  const inp = { width: "100%", boxSizing: "border-box", fontSize: 14.5, padding: "8px 9px", borderRadius: 8, border: `1.5px solid ${C.line}`, fontFamily: F.body };

  return (
    <Cartao style={{ borderColor: C.navy }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontWeight: 800, color: C.navy }}>📐 Projeto de mistura {existente ? `· v${p.versao}` : ""}</div>
        <button onClick={aoFechar} style={{ border: "none", background: "none", color: C.mut, fontWeight: 800, cursor: "pointer" }}>✕</button>
      </div>
      {travado && <div style={{ background: C.warnBg, color: C.amber, fontSize: 13, fontWeight: 600, borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>🔒 Projeto aprovado — alterações exigem o coordenador (gera nova versão auditada).</div>}
      <fieldset disabled={travado} style={{ border: "none", padding: 0, margin: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Campo rotulo="Código do projeto *" value={p.codigo} onChange={m("codigo")} placeholder="PM-2026-01" />
          <Campo rotulo="Cliente" value={p.cliente} onChange={m("cliente")} />
          <Sel rotulo="Obra vinculada" value={p.obraId} onChange={m("obraId")}>
            <option value="">Todas</option>{obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
          </Sel>
          <Campo rotulo="Usina" value={p.usina} onChange={m("usina")} />
          <Campo rotulo="Tipo de mistura" value={p.tipoMistura} onChange={m("tipoMistura")} />
          <Sel rotulo="Tipo de ligante" value={p.tipoLigante} onChange={m("tipoLigante")}>
            {["CAP 30/45","CAP 50/70","CAP 85/100","AMP 55/75-E","AMP 60/85-E","AMP 65/90-E","Asfalto-borracha AB-8","Asfalto-borracha AB-22"].map((o) => <option key={o}>{o}</option>)}
          </Sel>
          <Campo rotulo="Teor de ligante de projeto *" sufixo="%" inputMode="decimal" value={p.teorProjeto} onChange={m("teorProjeto")} />
          <Campo rotulo="Tolerância do teor" sufixo="± %" inputMode="decimal" value={p.tolTeor} onChange={m("tolTeor")} />
          <Sel rotulo="Faixa granulométrica" value={p.faixa} onChange={(e) => mudarFaixa(e.target.value)}>
            {Object.keys(FAIXAS_DNIT).map((f) => <option key={f}>{f}</option>)}
          </Sel>
          <Sel rotulo="Norma / especificação de referência" value={p.norma} onChange={m("norma")}>
            {NORMAS.map((n) => <option key={n}>{n}</option>)}
          </Sel>
          <Campo rotulo="Responsável técnico" value={p.responsavel} onChange={m("responsavel")} />
          <Sel rotulo="Status" value={p.status} onChange={m("status")} disabled={perfil.papel !== "coordenador" && p.status === "Aprovado"}>
            {["Em elaboração","Em análise","Aprovado","Suspenso","Substituído","Arquivado"].map((s) => <option key={s}>{s}</option>)}
          </Sel>
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.mut, margin: "6px 0" }}>Curva de projeto (% passante) · limites da {p.faixa} pré-carregados</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ color: C.mut, textAlign: "left" }}><th style={{ padding: 4 }}>Peneira</th><th>Faixa norma</th><th>Projeto %</th><th>Tol ±</th></tr></thead>
            <tbody>{p.peneiras.map((r, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${C.line}` }}>
                <td style={{ padding: 4, fontWeight: 700 }}>{r.nome}</td>
                <td style={{ color: C.mut }}>{r.limInf}–{r.limSup}</td>
                <td><input style={{ ...inp, width: 70 }} inputMode="decimal" value={r.projeto} onChange={(e) => mp(i, "projeto", e.target.value)} /></td>
                <td><input style={{ ...inp, width: 55 }} inputMode="decimal" value={r.tol} onChange={(e) => mp(i, "tol", e.target.value)} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <Campo rotulo="Observações" value={p.obs} onChange={m("obs")} style={{ marginTop: 8 }} />
        <Btn onClick={salvar}>Salvar projeto</Btn>
      </fieldset>
    </Cartao>
  );
}

// ----------------------------------------------------------------------------
// Equipamentos (patrimônio + validade de calibração)
// ----------------------------------------------------------------------------
function BlocoEquipamentos({ perfil }) {
  const eqs = useEquipamentos();
  const [f, setF] = useState({ nome: "", patrimonio: "", validade: "" });
  const criar = async () => {
    if (!f.nome.trim()) return;
    await addDoc(collection(db, "equipamentos"), { ...f, criadoEm: agoraISO(), criadoPor: perfil.nome });
    setF({ nome: "", patrimonio: "", validade: "" });
  };
  return (
    <Cartao>
      <div style={{ fontWeight: 800, color: C.navy, marginBottom: 8 }}>⚙️ Equipamentos e calibração</div>
      {eqs.map((e) => (
        <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px dashed ${C.line}`, fontSize: 13.5 }}>
          <span><b>{e.nome}</b> <span style={{ color: C.mut }}>· patr. {e.patrimonio || "—"}</span></span>
          <span style={{ fontWeight: 700, color: calibVencida(e) ? C.red : C.ok }}>{e.validade ? `calib. até ${fmtBR(e.validade)}` : "sem validade"}{calibVencida(e) ? " ⚠️" : ""}</span>
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr auto", gap: 7, marginTop: 10 }}>
        <input placeholder="Equipamento (ex.: Rotarex)" value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} style={{ fontSize: 14, padding: "9px", borderRadius: 9, border: `1.5px solid ${C.line}` }} />
        <input placeholder="Patrimônio" value={f.patrimonio} onChange={(e) => setF({ ...f, patrimonio: e.target.value })} style={{ fontSize: 14, padding: "9px", borderRadius: 9, border: `1.5px solid ${C.line}` }} />
        <input type="date" value={f.validade} onChange={(e) => setF({ ...f, validade: e.target.value })} style={{ fontSize: 14, padding: "8px", borderRadius: 9, border: `1.5px solid ${C.line}` }} />
        <Btn cheio={false} onClick={criar} style={{ padding: "9px 14px" }}>+</Btn>
      </div>
    </Cartao>
  );
}

// ----------------------------------------------------------------------------
// Vínculo do ensaio com a produção (carga · intervalo de cargas · lote/jornada)
// ----------------------------------------------------------------------------
function BlocoVinculo({ v, setV, cargas }) {
  const porId = (id) => cargas.find((c) => c.id === id);
  const resumo = () => {
    if (v.tipo === "carga") { const c = porId(v.cargaId); return c ? `${c.placa} · ${c.tonelagem} t · saída ${c.horaSaida}` : ""; }
    if (v.tipo === "intervalo") {
      const idx = [cargas.findIndex((c) => c.id === v.primeiraId), cargas.findIndex((c) => c.id === v.ultimaId)];
      if (idx[0] < 0 || idx[1] < 0) return "";
      const [a, b] = idx[0] <= idx[1] ? idx : [idx[1], idx[0]];
      const fatia = cargas.slice(a, b + 1);
      const t = fatia.reduce((s, c) => s + (c.tonelagem || 0), 0);
      return `${fatia.length} cargas · ${t.toFixed(1)} t · ${fatia[0]?.horaSaida}–${fatia[fatia.length - 1]?.horaSaida}`;
    }
    const t = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
    return `Jornada completa · ${cargas.length} cargas · ${t.toFixed(1)} t`;
  };
  return (
    <>
      <Sel rotulo="Representatividade da amostra (vínculo com a produção)" value={v.tipo} onChange={(e) => setV({ ...v, tipo: e.target.value })}>
        <option value="lote">Lote / jornada de produção</option>
        <option value="intervalo">Intervalo de cargas</option>
        <option value="carga">Uma carga específica</option>
      </Sel>
      {v.tipo === "carga" && (
        <Sel rotulo="Carga" value={v.cargaId || ""} onChange={(e) => setV({ ...v, cargaId: e.target.value })}>
          <option value="">—</option>{cargas.map((c) => <option key={c.id} value={c.id}>{c.placa} · {c.horaSaida} · {c.tonelagem} t</option>)}
        </Sel>
      )}
      {v.tipo === "intervalo" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Sel rotulo="Primeira carga" value={v.primeiraId || ""} onChange={(e) => setV({ ...v, primeiraId: e.target.value })}>
            <option value="">—</option>{cargas.map((c) => <option key={c.id} value={c.id}>{c.placa} · {c.horaSaida}</option>)}
          </Sel>
          <Sel rotulo="Última carga" value={v.ultimaId || ""} onChange={(e) => setV({ ...v, ultimaId: e.target.value })}>
            <option value="">—</option>{cargas.map((c) => <option key={c.id} value={c.id}>{c.placa} · {c.horaSaida}</option>)}
          </Sel>
        </div>
      )}
      {resumo() && <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, background: C.blueBg, borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>📦 Representa: {resumo()}</div>}
      <Campo rotulo="Justificativa / plano de amostragem" value={v.justificativa || ""} onChange={(e) => setV({ ...v, justificativa: e.target.value })} placeholder="Ex.: 1 ensaio a cada 5 cargas conforme plano da fiscalização" />
    </>
  );
}

// ----------------------------------------------------------------------------
// Ensaio de teor de ligante — cálculo automático com memória e auditoria
// ----------------------------------------------------------------------------
function FormTeor({ perfil, obra, usinaNome, cargas, projetos, aoFechar, existente }) {
  const eqs = useEquipamentos();
  const ensaiosDia = useEnsaiosDia(obra.id, hojeISO());
  const [e, setE] = useState(existente || RASCUNHOS.teorDados || {
    jornada: "Diurna", metodo: METODOS_TEOR[0], projetoId: projetos.find((p) => p.status === "Aprovado")?.id || projetos[0]?.id || "",
    equipamentoId: "", amostra: "", massaInicial: "", massaAgregado: "", massaFiltro: "", obs: "",
    vinculo: { tipo: "lote" },
  });
  const proj = projetos.find((p) => p.id === e.projetoId);
  const eq = eqs.find((x) => x.id === e.equipamentoId);
  const r = calcTeor(e.massaInicial, e.massaAgregado, e.massaFiltro, proj);
  const docPath = existente?.id ? `ensaios/${existente.id}` : null;
  const [fotosLocais, setFotosLocais] = useState(() => (existente ? [] : RASCUNHOS.teorFotos || []));
  const [etapa, setEtapa] = useState("Identificação da amostra");
  const ETAPAS = ["Identificação da amostra","Pesagem inicial","Equipamento Rotarex","Processo de extração","Secagem","Agregado recuperado","Pesagem final","Resultado"];
  useEffect(() => { if (!existente) RASCUNHOS.teorDados = e; }, [e]);
  useEffect(() => { if (!existente) RASCUNHOS.teorFotos = fotosLocais; }, [fotosLocais]);

  const concluir = async () => {
    if (!proj) return alert("Selecione o projeto de mistura.");
    if (!r || r.erro) return alert(r?.erro || "Preencha as massas para calcular o teor.");
    const seq = ensaiosDia.filter((x) => x.tipo === "teor").length + 1;
    const dados = {
      tipo: "teor", codigo: existente?.codigo || `TL-${String(seq).padStart(3, "0")}`,
      obraId: obra.id, obraNome: obra.nome, usina: usinaNome || "", dataRef: hojeISO(),
      jornada: e.jornada, tecnico: perfil.nome, metodo: e.metodo, norma: proj.norma,
      projetoId: proj.id, projetoCod: proj.codigo,
      equipamento: eq ? { nome: eq.nome, patrimonio: eq.patrimonio, validade: eq.validade, vencida: calibVencida(eq) } : null,
      vinculo: e.vinculo, amostra: e.amostra,
      dados: { massaInicial: num(e.massaInicial), massaAgregado: num(e.massaAgregado), massaFiltro: num(e.massaFiltro) || 0 },
      resultado: r, situacao: r.sit, obs: e.obs, status: "concluido",
      horaEnsaio: agoraHM(), criadoEm: existente?.criadoEm || agoraISO(), ultimaEdicao: edicao(perfil),
      historico: existente ? [...(existente.historico || []), { em: agoraISO(), por: perfil.nome, resultadoAnterior: existente.resultado?.teor }] : [],
    };
    let id = existente?.id;
    if (id) updateDoc(doc(db, "ensaios", id), dados).catch(() => {});
    else { const dref = doc(collection(db, "ensaios")); setDoc(dref, { ...dados, fotos: [] }).catch(() => {}); id = dref.id; }
    fotosLocais.forEach((f) => anexarFoto(`ensaios/${id}`, "fotos", f.foto, f.etapa));
    delete RASCUNHOS.teorDados; delete RASCUNHOS.teorFotos;
    aoFechar();
  };

  return (
    <Cartao style={{ borderColor: C.navy }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontWeight: 800, color: C.navy }}>🧪 Teor de ligante {existente ? `· ${existente.codigo} (correção auditada)` : ""}</div>
        <button onClick={aoFechar} style={{ border: "none", background: "none", color: C.mut, fontWeight: 800, cursor: "pointer" }}>✕</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Sel rotulo="Projeto de mistura *" value={e.projetoId} onChange={(ev) => setE({ ...e, projetoId: ev.target.value })}>
          <option value="">—</option>{projetos.map((p) => <option key={p.id} value={p.id}>{p.codigo} · {p.faixa} ({p.status})</option>)}
        </Sel>
        <Sel rotulo="Jornada" value={e.jornada} onChange={(ev) => setE({ ...e, jornada: ev.target.value })}>
          <option>Diurna</option><option>Noturna</option>
        </Sel>
        <Sel rotulo="Método do ensaio" value={e.metodo} onChange={(ev) => setE({ ...e, metodo: ev.target.value })} style={{ gridColumn: "1 / -1" }}>
          {METODOS_TEOR.map((m) => <option key={m}>{m}</option>)}
        </Sel>
        <Sel rotulo="Equipamento" value={e.equipamentoId} onChange={(ev) => setE({ ...e, equipamentoId: ev.target.value })}>
          <option value="">—</option>{eqs.map((x) => <option key={x.id} value={x.id}>{x.nome} · patr. {x.patrimonio}</option>)}
        </Sel>
        <Campo rotulo="Identificação da amostra" value={e.amostra} onChange={(ev) => setE({ ...e, amostra: ev.target.value })} placeholder="AM-01" />
      </div>
      {eq && calibVencida(eq) && <div style={{ background: C.redBg, color: C.red, fontSize: 13, fontWeight: 600, borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>⚠️ Calibração vencida em {fmtBR(eq.validade)} — registre a exceção autorizada nas observações.</div>}
      <BlocoVinculo v={e.vinculo} setV={(v) => setE({ ...e, vinculo: v })} cargas={cargas} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <Campo rotulo="Massa inicial (Mi)" sufixo="g" inputMode="decimal" value={e.massaInicial} onChange={(ev) => setE({ ...e, massaInicial: ev.target.value })} />
        <Campo rotulo="Agreg. recuperado (Ma)" sufixo="g" inputMode="decimal" value={e.massaAgregado} onChange={(ev) => setE({ ...e, massaAgregado: ev.target.value })} />
        <Campo rotulo="Retido no filtro (Mf)" sufixo="g" inputMode="decimal" value={e.massaFiltro} onChange={(ev) => setE({ ...e, massaFiltro: ev.target.value })} />
      </div>
      {r?.erro && <div style={{ background: C.redBg, color: C.red, fontSize: 13.5, fontWeight: 600, borderRadius: 10, padding: "9px 12px", marginBottom: 10 }}>🚫 {r.erro}</div>}
      {r && !r.erro && (
        <div style={{ background: SIT[r.sit].bg, borderRadius: 12, padding: "12px 14px", marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 26, color: SIT[r.sit].cor }}>{r.teor.toFixed(2)}%</div>
            <SeloSit s={r.sit} />
          </div>
          <div style={{ fontSize: 12.5, color: C.ink, marginTop: 4 }}>
            {r.memoria} &nbsp;·&nbsp; Projeto {r.tp ?? "—"}% ± {r.tol}% &nbsp;·&nbsp; desvio {r.desvio > 0 ? "+" : ""}{r.desvio}% ({r.desvioPct > 0 ? "+" : ""}{r.desvioPct}% rel.)
          </div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end", marginBottom: 4 }}>
        <Sel rotulo="Etapa da fotografia" value={etapa} onChange={(ev) => setEtapa(ev.target.value)} style={{ marginBottom: 0 }}>
          {ETAPAS.map((x) => <option key={x}>{x}</option>)}
        </Sel>
        {docPath
          ? <BotaoFoto obraNome={obra.nome} docPath={docPath} campo="fotos" legenda={etapa} rotulo="📷" />
          : <BotaoFoto obraNome={obra.nome} aoLocal={(foto) => setFotosLocais((v) => [...v, { foto, etapa }])} rotulo="📷" />}
      </div>
      <Miniaturas fotos={existente?.fotos} locais={fotosLocais.map((f) => f.foto)} aoRemoverLocal={(i) => setFotosLocais((v) => v.filter((_, j) => j !== i))} />
      <Campo rotulo="Observações" value={e.obs} onChange={(ev) => setE({ ...e, obs: ev.target.value })} style={{ marginTop: 8 }} />
      <Btn tom="ok" onClick={concluir}>✔ Concluir ensaio de teor</Btn>
    </Cartao>
  );
}

// ----------------------------------------------------------------------------
// Ensaio de granulometria — tabela completa com validações e alertas
// ----------------------------------------------------------------------------
function FormGran({ perfil, obra, usinaNome, cargas, projetos, aoFechar, existente }) {
  const eqs = useEquipamentos();
  const ensaiosDia = useEnsaiosDia(obra.id, hojeISO());
  const projIni = projetos.find((p) => p.id === existente?.projetoId) || projetos.find((p) => p.status === "Aprovado") || projetos[0];
  const [e, setE] = useState(existente ? { ...existente, linhas: existente.dados.linhas } : RASCUNHOS.granDados || {
    jornada: "Diurna", projetoId: projIni?.id || "", equipamentoId: "", amostra: "",
    massaSeca: "", fundo: "", obs: "", vinculo: { tipo: "lote" },
    linhas: (projIni?.peneiras || FAIXAS_DNIT["Faixa C"].map(([nome, li, ls]) => ({ nome, projeto: "", limInf: li, limSup: ls, tol: tolPeneira(nome) }))).map((p) => ({ ...p, massa: "" })),
  });
  const proj = projetos.find((p) => p.id === e.projetoId);
  const eq = eqs.find((x) => x.id === e.equipamentoId);
  const [fotosLocais, setFotosLocais] = useState(() => (existente ? [] : RASCUNHOS.granFotos || []));
  const [etapa, setEtapa] = useState("Identificação");
  const ETAPAS = ["Identificação","Amostra seca","Conjunto de peneiras","Peneiramento","Material retido","Pesagem","Resultado"];
  useEffect(() => { if (!existente) RASCUNHOS.granDados = e; }, [e]);
  useEffect(() => { if (!existente) RASCUNHOS.granFotos = fotosLocais; }, [fotosLocais]);
  const trocarProjeto = (id) => {
    const p = projetos.find((x) => x.id === id);
    setE({ ...e, projetoId: id, linhas: (p?.peneiras || e.linhas).map((pe) => ({ ...pe, massa: e.linhas.find((l) => l.nome === pe.nome)?.massa || "" })) });
  };
  const r = calcGran(e.massaSeca, e.linhas, e.fundo);
  const docPath = existente?.id ? `ensaios/${existente.id}` : null;

  const concluir = async () => {
    if (!proj) return alert("Selecione o projeto de mistura.");
    if (!r || r.geral == null) return alert("Preencha a massa seca e as massas retidas.");
    const seq = ensaiosDia.filter((x) => x.tipo === "granulometria").length + 1;
    const dados = {
      tipo: "granulometria", codigo: existente?.codigo || `GR-${String(seq).padStart(3, "0")}`,
      obraId: obra.id, obraNome: obra.nome, usina: usinaNome || "", dataRef: hojeISO(),
      jornada: e.jornada, tecnico: perfil.nome, norma: proj.norma, projetoId: proj.id, projetoCod: proj.codigo,
      equipamento: eq ? { nome: eq.nome, patrimonio: eq.patrimonio, validade: eq.validade, vencida: calibVencida(eq) } : null,
      vinculo: e.vinculo, amostra: e.amostra,
      dados: { massaSeca: num(e.massaSeca), fundo: num(e.fundo) || 0, linhas: r.linhas, soma: r.soma, perda: r.perda },
      resultado: { geral: r.geral, alertas: r.alertas }, situacao: r.geral, obs: e.obs, status: "concluido",
      horaEnsaio: agoraHM(), criadoEm: existente?.criadoEm || agoraISO(), ultimaEdicao: edicao(perfil),
      historico: existente ? [...(existente.historico || []), { em: agoraISO(), por: perfil.nome }] : [],
    };
    let id = existente?.id;
    if (id) updateDoc(doc(db, "ensaios", id), dados).catch(() => {});
    else { const dref = doc(collection(db, "ensaios")); setDoc(dref, { ...dados, fotos: [] }).catch(() => {}); id = dref.id; }
    fotosLocais.forEach((f) => anexarFoto(`ensaios/${id}`, "fotos", f.foto, f.etapa));
    delete RASCUNHOS.granDados; delete RASCUNHOS.granFotos;
    aoFechar();
  };
  const inp = { width: 64, fontSize: 13.5, padding: "7px 8px", borderRadius: 8, border: `1.5px solid ${C.line}`, fontFamily: F.body };

  return (
    <Cartao style={{ borderColor: C.navy }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontWeight: 800, color: C.navy }}>📊 Granulometria {existente ? `· ${existente.codigo}` : ""}</div>
        <button onClick={aoFechar} style={{ border: "none", background: "none", color: C.mut, fontWeight: 800, cursor: "pointer" }}>✕</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Sel rotulo="Projeto de mistura *" value={e.projetoId} onChange={(ev) => trocarProjeto(ev.target.value)}>
          <option value="">—</option>{projetos.map((p) => <option key={p.id} value={p.id}>{p.codigo} · {p.faixa}</option>)}
        </Sel>
        <Sel rotulo="Jornada" value={e.jornada} onChange={(ev) => setE({ ...e, jornada: ev.target.value })}>
          <option>Diurna</option><option>Noturna</option>
        </Sel>
        <Sel rotulo="Equipamento (série de peneiras)" value={e.equipamentoId} onChange={(ev) => setE({ ...e, equipamentoId: ev.target.value })}>
          <option value="">—</option>{eqs.map((x) => <option key={x.id} value={x.id}>{x.nome} · patr. {x.patrimonio}</option>)}
        </Sel>
        <Campo rotulo="Amostra" value={e.amostra} onChange={(ev) => setE({ ...e, amostra: ev.target.value })} placeholder="AM-01 (agregado recuperado)" />
        <Campo rotulo="Massa seca inicial *" sufixo="g" inputMode="decimal" value={e.massaSeca} onChange={(ev) => setE({ ...e, massaSeca: ev.target.value })} />
        <Campo rotulo="Massa do fundo" sufixo="g" inputMode="decimal" value={e.fundo} onChange={(ev) => setE({ ...e, fundo: ev.target.value })} />
      </div>
      <BlocoVinculo v={e.vinculo} setV={(v) => setE({ ...e, vinculo: v })} cargas={cargas} />
      <div style={{ overflowX: "auto", margin: "4px 0 10px" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12.5, minWidth: 560 }}>
          <thead><tr style={{ color: C.mut, textAlign: "left" }}>
            <th style={{ padding: 4 }}>Peneira</th><th>Norma</th><th>Proj.</th><th>Lim. aplicado</th><th>Retida (g)</th><th>Passante</th><th>Dif.</th><th>Situação</th>
          </tr></thead>
          <tbody>{(r?.linhas || e.linhas).map((l, i) => (
            <tr key={i} style={{ borderTop: `1px solid ${C.line}` }}>
              <td style={{ padding: 4, fontWeight: 700 }}>{l.nome}</td>
              <td style={{ color: C.mut }}>{l.limInf}–{l.limSup}</td>
              <td>{l.projeto || "—"}</td>
              <td style={{ color: C.mut }}>{l.apInf != null && isFinite(l.apInf) ? `${Math.round(l.apInf * 10) / 10}–${Math.round(l.apSup * 10) / 10}` : "—"}</td>
              <td><input style={inp} inputMode="decimal" value={e.linhas[i].massa} onChange={(ev) => setE({ ...e, linhas: e.linhas.map((x, j) => (j === i ? { ...x, massa: ev.target.value } : x)) })} /></td>
              <td style={{ fontWeight: 800 }}>{l.passante != null ? `${l.passante}%` : "—"}</td>
              <td>{l.dif != null ? `${l.dif > 0 ? "+" : ""}${l.dif}` : "—"}</td>
              <td>{l.sit ? <SeloSit s={l.sit} /> : "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {r && (
        <div style={{ fontSize: 13, fontWeight: 600, color: Math.abs(r.perda) > 0.5 ? C.red : C.ink, background: Math.abs(r.perda) > 0.5 ? C.redBg : C.grayBg, borderRadius: 10, padding: "8px 12px", marginBottom: 8 }}>
          Fechamento: Σ retidas + fundo = {r.soma} g · perda {r.perda}% {r.geral && <span style={{ float: "right" }}><SeloSit s={r.geral} /></span>}
        </div>
      )}
      {r?.alertas?.map((a, i) => <div key={i} style={{ background: C.warnBg, color: C.amber, fontSize: 12.5, fontWeight: 600, borderRadius: 9, padding: "7px 11px", marginBottom: 6 }}>⚠️ {a}</div>)}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end", marginBottom: 4 }}>
        <Sel rotulo="Etapa da fotografia" value={etapa} onChange={(ev) => setEtapa(ev.target.value)} style={{ marginBottom: 0 }}>
          {ETAPAS.map((x) => <option key={x}>{x}</option>)}
        </Sel>
        {docPath
          ? <BotaoFoto obraNome={obra.nome} docPath={docPath} campo="fotos" legenda={etapa} rotulo="📷" />
          : <BotaoFoto obraNome={obra.nome} aoLocal={(foto) => setFotosLocais((v) => [...v, { foto, etapa }])} rotulo="📷" />}
      </div>
      <Miniaturas fotos={existente?.fotos} locais={fotosLocais.map((f) => f.foto)} aoRemoverLocal={(i) => setFotosLocais((v) => v.filter((_, j) => j !== i))} />
      <Campo rotulo="Observações" value={e.obs} onChange={(ev) => setE({ ...e, obs: ev.target.value })} style={{ marginTop: 8 }} />
      <Btn tom="ok" onClick={concluir}>✔ Concluir granulometria</Btn>
    </Cartao>
  );
}

// ----------------------------------------------------------------------------
// Contexto de trabalho do técnico de usina (obra + usina do dia)
// ----------------------------------------------------------------------------
const ctxUsina = () => { try { const f = JSON.parse(localStorage.getItem(RASCUNHO) || "{}"); return { obraId: f.obraId || "", usina: f.usina || "" }; } catch { return { obraId: "", usina: "" }; } };
const salvarCtxUsina = (patch) => { try { localStorage.setItem(RASCUNHO, JSON.stringify({ ...JSON.parse(localStorage.getItem(RASCUNHO) || "{}"), ...patch })); } catch {} };

function CabecalhoUsina({ obras, ctx, setCtx }) {
  return (
    <Cartao style={{ background: C.navy, border: "none" }}>
      <Sel rotulo={<span style={{ color: "#AEB8E0" }}>Obra de destino</span>} value={ctx.obraId} onChange={(e) => { setCtx({ ...ctx, obraId: e.target.value }); salvarCtxUsina({ obraId: e.target.value }); }}>
        <option value="">Selecionar obra…</option>
        {obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
      </Sel>
      <Campo rotulo={<span style={{ color: "#AEB8E0" }}>Usina</span>} value={ctx.usina} onChange={(e) => { setCtx({ ...ctx, usina: e.target.value }); salvarCtxUsina({ usina: e.target.value }); }} placeholder="Ex.: AUTEM — Araraquara" style={{ marginBottom: 0 }} />
    </Cartao>
  );
}

// ----------------------------------------------------------------------------
// Aba Ensaios (usina): lista do dia + teor + granulometria + projetos + equip.
// ----------------------------------------------------------------------------
function EnsaiosUsina({ perfil }) {
  const obras = useObras();
  const [ctx, setCtx] = useState(ctxUsina());
  const obra = obras.find((o) => o.id === ctx.obraId);
  const cargas = useCargasDia(hojeISO()).filter((c) => c.obraId === ctx.obraId);
  const ensaios = useEnsaiosDia(ctx.obraId, hojeISO());
  const projetos = useProjetos(ctx.obraId);
  const [sub, setSub] = useState("ensaios");
  const [form, setForm] = useState(() => RASCUNHOS.formEnsaios || null); // {tipo, existente}
  useEffect(() => { RASCUNHOS.formEnsaios = form; }, [form]);

  const Seg = ({ id, rot }) => (
    <button onClick={() => { setSub(id); setForm(null); }} style={{ flex: 1, border: "none", cursor: "pointer", padding: "9px 6px", borderRadius: 10, fontFamily: F.body, fontWeight: 700, fontSize: 13, background: sub === id ? C.navy : "transparent", color: sub === id ? "#fff" : C.mut }}>{rot}</button>
  );

  return (
    <>
      <CabecalhoUsina obras={obras} ctx={ctx} setCtx={setCtx} />
      <div style={{ display: "flex", gap: 4, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 12, padding: 4, marginBottom: 12 }}>
        <Seg id="ensaios" rot="🧪 Ensaios" /><Seg id="projetos" rot="📐 Projetos" /><Seg id="equip" rot="⚙️ Equip." />
      </div>

      {sub === "equip" && <BlocoEquipamentos perfil={perfil} />}

      {sub === "projetos" && (
        <>
          {form?.tipo === "projeto"
            ? <FormProjeto perfil={perfil} obras={obras} existente={form.existente} aoFechar={() => setForm(null)} />
            : <Btn onClick={() => setForm({ tipo: "projeto" })} style={{ marginBottom: 12 }}>➕ Novo projeto de mistura</Btn>}
          {projetos.map((p) => (
            <Cartao key={p.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 800, color: C.navy }}>{p.codigo} <span style={{ color: C.mut, fontWeight: 600, fontSize: 13 }}>· v{p.versao}</span></div>
                <span style={{ fontSize: 11.5, fontWeight: 700, padding: "3px 9px", borderRadius: 99, color: p.status === "Aprovado" ? C.ok : C.amber, background: p.status === "Aprovado" ? C.okBg : C.warnBg }}>{p.status}</span>
              </div>
              <Linha k="Mistura · faixa · ligante" v={`${p.tipoMistura || "—"} · ${p.faixa} · ${p.tipoLigante}`} />
              <Linha k="Teor de projeto" v={`${p.teorProjeto}% ± ${p.tolTeor}%`} forte />
              <Linha k="Norma" v={p.norma} />
              <button onClick={() => setForm({ tipo: "projeto", existente: p })} style={{ background: "none", border: "none", color: C.blue, fontWeight: 700, fontSize: 13, marginTop: 8, cursor: "pointer", padding: 0 }}>✏️ Abrir / editar</button>
            </Cartao>
          ))}
        </>
      )}

      {sub === "ensaios" && (!ctx.obraId
        ? <Cartao><div style={{ color: C.mut, textAlign: "center" }}>Selecione a obra para lançar ensaios.</div></Cartao>
        : <>
          {form?.tipo === "teor" && obra && <FormTeor perfil={perfil} obra={obra} usinaNome={ctx.usina} cargas={cargas} projetos={projetos} existente={form.existente} aoFechar={() => setForm(null)} />}
          {form?.tipo === "gran" && obra && <FormGran perfil={perfil} obra={obra} usinaNome={ctx.usina} cargas={cargas} projetos={projetos} existente={form.existente} aoFechar={() => setForm(null)} />}
          {!form && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <Btn onClick={() => setForm({ tipo: "teor" })}>🧪 Teor de ligante</Btn>
              <Btn onClick={() => setForm({ tipo: "gran" })}>📊 Granulometria</Btn>
            </div>
          )}
          {ensaios.map((en) => (
            <Cartao key={en.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div style={{ fontWeight: 800, color: C.navy }}>{en.codigo} · {en.tipo === "teor" ? "Teor de ligante" : "Granulometria"}</div>
                <SeloSit s={en.situacao} />
              </div>
              {en.tipo === "teor"
                ? <Linha k="Resultado" v={`${en.resultado?.teor?.toFixed(2)}% (projeto ${en.resultado?.tp}% ± ${en.resultado?.tol}%) · desvio ${en.resultado?.desvio > 0 ? "+" : ""}${en.resultado?.desvio}%`} forte />
                : <Linha k="Resultado" v={`${(en.dados?.linhas || []).filter((l) => l.sit === "conforme").length}/${(en.dados?.linhas || []).filter((l) => l.sit).length} peneiras conformes · perda ${en.dados?.perda}%`} forte />}
              <Linha k="Vínculo" v={en.vinculo?.tipo === "lote" ? "Lote/jornada" : en.vinculo?.tipo === "intervalo" ? "Intervalo de cargas" : "Carga específica"} />
              <Linha k="Técnico · hora" v={`${en.tecnico} · ${en.horaEnsaio}`} />
              <Miniaturas fotos={en.fotos} />
              <button onClick={() => setForm({ tipo: en.tipo === "teor" ? "teor" : "gran", existente: en })} style={{ background: "none", border: "none", color: C.blue, fontWeight: 700, fontSize: 13, marginTop: 8, cursor: "pointer", padding: 0 }}>✏️ Corrigir (mantém histórico)</button>
            </Cartao>
          ))}
          {!ensaios.length && <Cartao><div style={{ color: C.mut, textAlign: "center" }}>Nenhum ensaio hoje. A produção sem cobertura de ensaio aparece no Resumo.</div></Cartao>}
        </>)}
    </>
  );
}

// ----------------------------------------------------------------------------
// Minuta de análise técnica — gerada SOMENTE a partir de dados registrados
// ----------------------------------------------------------------------------
function gerarMinuta({ cargas, ensaios, projeto, obra }) {
  const p = [];
  const ton = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const temps = cargas.map((c) => c.tempSaida).filter((v) => v != null);
  const ret = cargas.filter((c) => c.conformeSaida === false);
  if (cargas.length) {
    p.push(`Foram expedidas ${cargas.length} carga(s), totalizando ${ton.toFixed(1)} t, no período de ${cargas[0].horaSaida} a ${cargas[cargas.length - 1].horaSaida}.`);
    p.push(`Temperaturas de saída entre ${Math.min(...temps)} °C e ${Math.max(...temps)} °C (média ${(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)} °C), para o critério de ${LIMITES.tempSaidaMin}–${LIMITES.tempSaidaMax} °C. ${ret.length ? `${ret.length} carga(s) apresentaram temperatura fora da faixa: ${ret.map((c) => c.placa).join(", ")}.` : "Todas as cargas dentro da faixa."}`);
  } else p.push("Não houve expedição de cargas registrada na data.");
  const teores = ensaios.filter((e) => e.tipo === "teor");
  teores.forEach((e) => p.push(`Ensaio ${e.codigo} (${e.metodo.split("—")[0].trim()}): teor de ligante medido ${e.resultado.teor.toFixed(2)}%, para projeto ${e.resultado.tp}% ± ${e.resultado.tol}% — desvio de ${e.resultado.desvio > 0 ? "+" : ""}${e.resultado.desvio}% — situação: ${(SIT[e.situacao] || SIT.atencao).rot.toUpperCase()}. Representatividade: ${e.vinculo?.tipo === "lote" ? "lote/jornada" : e.vinculo?.tipo === "intervalo" ? "intervalo de cargas" : "carga específica"}.`));
  const grans = ensaios.filter((e) => e.tipo === "granulometria");
  grans.forEach((e) => {
    const fora = (e.dados?.linhas || []).filter((l) => l.sit && l.sit !== "conforme");
    p.push(`Ensaio ${e.codigo} (granulometria do agregado recuperado): ${fora.length ? `peneira(s) fora do limite aplicado: ${fora.map((l) => `${l.nome} (${l.passante}%)`).join(", ")}` : "todas as peneiras dentro do limite aplicado"}; perda de massa no peneiramento de ${e.dados?.perda}% — situação geral: ${(SIT[e.situacao] || SIT.atencao).rot.toUpperCase()}.`);
  });
  if (!ensaios.length && cargas.length) p.push("Não foram registrados ensaios de teor de ligante ou granulometria para a produção da data — produção sem cobertura de ensaio.");
  const eqV = ensaios.filter((e) => e.equipamento?.vencida);
  if (eqV.length) p.push(`Atenção: ensaio(s) realizados com calibração vencida: ${eqV.map((e) => e.codigo).join(", ")}.`);
  p.push(`Critério adotado conforme projeto ${projeto ? projeto.codigo : "—"} e especificação contratual cadastrados${projeto ? ` (${projeto.norma})` : ""}.`);
  p.push("Minuta gerada automaticamente a partir dos dados registrados. Sujeita a revisão, edição e aprovação do responsável técnico.");
  return p.join("\n\n");
}

// Conformidade por eixo — sem selo único que esconda pendências
function eixosConformidade({ cargas, ensaios }) {
  const temps = cargas.length ? (cargas.some((c) => c.conformeSaida === false) ? "nao_conforme" : "conforme") : null;
  const teor = ensaios.filter((e) => e.tipo === "teor").map((e) => e.situacao);
  const gran = ensaios.filter((e) => e.tipo === "granulometria").map((e) => e.situacao);
  const pior = (a) => (a.includes("nao_conforme") ? "nao_conforme" : a.includes("atencao") ? "atencao" : a.length ? "conforme" : null);
  const fotosOk = cargas.some((c) => (c.fotosUsina || []).length) || ensaios.some((e) => (e.fotos || []).length);
  const calib = ensaios.some((e) => e.equipamento?.vencida) ? "nao_conforme" : ensaios.some((e) => e.equipamento) ? "conforme" : null;
  return [
    ["Temperaturas de produção", temps],
    ["Teor de ligante", pior(teor) || "pendente"],
    ["Granulometria", pior(gran) || "pendente"],
    ["Registro fotográfico", fotosOk ? "conforme" : "pendente"],
    ["Calibração de equipamentos", calib || "pendente"],
    ["Completude dos registros", cargas.length && ensaios.length ? "conforme" : "pendente"],
  ];
}

// ----------------------------------------------------------------------------
// Gráficos SVG (curva granulométrica e temperatura das cargas)
// ----------------------------------------------------------------------------
function CurvaGran({ linhas, w = 660, h = 250 }) {
  const ls = linhas.filter((l) => l.limInf != null);
  if (!ls.length) return null;
  const n = ls.length, mx = 44, my = 22;
  const X = (i) => mx + ((n - 1 - i) / (n - 1)) * (w - mx - 14); // finas à esquerda, graúdas à direita
  const Y = (v) => h - my - (v / 100) * (h - my - 14);
  const pol = (get) => ls.map((l, i) => `${X(i)},${Y(get(l) ?? 0)}`).join(" ");
  const banda = [...ls.map((l, i) => `${X(i)},${Y(l.limSup)}`), ...[...ls].reverse().map((l) => `${X(ls.indexOf(l))},${Y(l.limInf)}`)].join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10 }}>
      {[0, 20, 40, 60, 80, 100].map((v) => (
        <g key={v}><line x1={mx} x2={w - 14} y1={Y(v)} y2={Y(v)} stroke="#EDF0F7" /><text x={mx - 6} y={Y(v) + 4} fontSize="10" fill={C.mut} textAnchor="end">{v}%</text></g>
      ))}
      <polygon points={banda} fill="#E8EFFD" opacity="0.7" />
      <polyline points={pol((l) => l.limSup)} fill="none" stroke="#9DB4E8" strokeWidth="1.4" />
      <polyline points={pol((l) => l.limInf)} fill="none" stroke="#9DB4E8" strokeWidth="1.4" />
      {ls.some((l) => num(l.projeto) != null) && <polyline points={pol((l) => num(l.projeto))} fill="none" stroke={C.navy} strokeWidth="2" strokeDasharray="6 4" />}
      {ls.some((l) => l.passante != null) && <polyline points={pol((l) => l.passante)} fill="none" stroke={C.red} strokeWidth="2.4" />}
      {ls.map((l, i) => l.passante != null && <circle key={i} cx={X(i)} cy={Y(l.passante)} r="3.4" fill={C.red} />)}
      {ls.map((l, i) => <text key={`t${i}`} x={X(i)} y={h - 6} fontSize="9.5" fill={C.mut} textAnchor="middle">{l.nome}</text>)}
      <text x={w - 16} y={16} fontSize="10.5" fill={C.mut} textAnchor="end">— faixa · ▬ ▬ projeto · ▬ medida</text>
    </svg>
  );
}
function GraficoTemp({ cargas, w = 660, h = 200 }) {
  const cs = cargas.filter((c) => c.tempSaida != null);
  if (!cs.length) return null;
  const mx = 40, my = 24, min = 100, max = 200;
  const X = (i) => mx + (cs.length === 1 ? 0.5 : i / (cs.length - 1)) * (w - mx - 16);
  const Y = (v) => h - my - ((Math.min(Math.max(v, min), max) - min) / (max - min)) * (h - my - 14);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10 }}>
      {[LIMITES.tempSaidaMin, LIMITES.tempSaidaMax].map((v) => (
        <g key={v}><line x1={mx} x2={w - 16} y1={Y(v)} y2={Y(v)} stroke={C.red} strokeDasharray="5 4" strokeWidth="1.2" /><text x={mx - 5} y={Y(v) + 4} fontSize="10" fill={C.red} textAnchor="end">{v}°</text></g>
      ))}
      <polyline points={cs.map((c, i) => `${X(i)},${Y(c.tempSaida)}`).join(" ")} fill="none" stroke={C.navy} strokeWidth="2.2" />
      {cs.map((c, i) => (
        <g key={i}>
          <circle cx={X(i)} cy={Y(c.tempSaida)} r="3.6" fill={c.conformeSaida === false ? C.red : C.navy} />
          <text x={X(i)} y={h - 8} fontSize="9" fill={C.mut} textAnchor="middle">{c.horaSaida}</text>
        </g>
      ))}
      <text x={w - 16} y={16} fontSize="10.5" fill={C.mut} textAnchor="end">Temperatura de saída por carga</text>
    </svg>
  );
}

// ----------------------------------------------------------------------------
// Resumo/dashboard da usina + minuta de análise + relatório diário da usina
// ----------------------------------------------------------------------------
function ResumoUsina({ perfil }) {
  const obras = useObras();
  const [ctx, setCtx] = useState(ctxUsina());
  const obra = obras.find((o) => o.id === ctx.obraId);
  const cargas = useCargasDia(hojeISO()).filter((c) => c.obraId === ctx.obraId);
  const ensaios = useEnsaiosDia(ctx.obraId, hojeISO());
  const projetos = useProjetos(ctx.obraId);
  const projeto = projetos.find((p) => p.status === "Aprovado") || projetos[0];
  const [analise, setAnalise] = useState(null);
  const [texto, setTexto] = useState("");
  const prontoA = useRef(false);
  const [imprimir, setImprimir] = useState(false);
  const aid = ctx.obraId ? `${ctx.obraId}_${hojeISO()}` : null;

  useEffect(() => {
    if (!aid) return;
    prontoA.current = false;
    return onSnapshot(doc(db, "analises", aid), (s) => {
      const d = s.data() || null;
      setAnalise(d);
      if (!prontoA.current) { setTexto(d?.texto || ""); prontoA.current = true; }
    });
  }, [aid]);
  useEffect(() => {
    if (!prontoA.current || !aid) return;
    const t = setTimeout(() => setDoc(doc(db, "analises", aid), { obraId: ctx.obraId, dataRef: hojeISO(), texto, editadoPor: perfil.nome, editadoEm: agoraISO() }, { merge: true }).catch(() => {}), 900);
    return () => clearTimeout(t);
  }, [texto]);

  if (!ctx.obraId) return <><CabecalhoUsina obras={obras} ctx={ctx} setCtx={setCtx} /><Cartao><div style={{ color: C.mut, textAlign: "center" }}>Selecione a obra.</div></Cartao></>;

  const ton = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const temps = cargas.map((c) => c.tempSaida).filter((v) => v != null);
  const retidas = cargas.filter((c) => c.conformeSaida === false);
  const teores = ensaios.filter((e) => e.tipo === "teor");
  const grans = ensaios.filter((e) => e.tipo === "granulometria");
  const ultTeor = teores[teores.length - 1];
  const ultGran = grans[grans.length - 1];
  const ultEnsaio = ensaios[ensaios.length - 1];
  const tonDesde = ultEnsaio ? cargas.filter((c) => (c.criadoEm || "") > (ultEnsaio.criadoEm || "")).reduce((s, c) => s + (c.tonelagem || 0), 0) : ton;
  const freqTon = num(obra?.freqTon);
  const ensaioDevido = freqTon != null && tonDesde >= freqTon;
  const eixos = eixosConformidade({ cargas, ensaios });

  const gerar = () => setTexto(gerarMinuta({ cargas, ensaios, projeto, obra }));
  const aprovar = () => setDoc(doc(db, "analises", aid), { aprovadoPor: perfil.nome, aprovadoEm: agoraISO(), minutaAuto: gerarMinuta({ cargas, ensaios, projeto, obra }) }, { merge: true });

  const Kpi = ({ v, r, cor }) => (
    <div style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 13, padding: "10px 6px", textAlign: "center" }}>
      <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 20, color: cor || C.navy }}>{v}</div>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: C.mut, marginTop: 2 }}>{r}</div>
    </div>
  );

  return (
    <>
      <CabecalhoUsina obras={obras} ctx={ctx} setCtx={setCtx} />
      <Titulo sub={`${obra?.nome} · ${fmtBR(hojeISO())}`}>Resumo da usina</Titulo>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 10 }}>
        <Kpi v={cargas.length} r="Cargas" />
        <Kpi v={`${ton.toFixed(1)} t`} r="Produção" />
        <Kpi v={retidas.length} r="Retidas / NC" cor={retidas.length ? C.red : C.ok} />
        <Kpi v={temps.length ? `${Math.min(...temps)}–${Math.max(...temps)}°` : "—"} r="Temp. mín–máx" />
        <Kpi v={temps.length ? `${(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(0)}°` : "—"} r="Temp. média" />
        <Kpi v={ensaios.length} r="Ensaios hoje" cor={ensaios.length ? C.navy : C.amber} />
        <Kpi v={ultTeor ? `${ultTeor.resultado.teor.toFixed(2)}%` : "—"} r={`Último teor (proj. ${projeto?.teorProjeto ?? "—"}%)`} cor={ultTeor ? (SIT[ultTeor.situacao] || SIT.atencao).cor : C.mut} />
        <Kpi v={ultGran ? `${(ultGran.dados.linhas || []).filter((l) => l.sit === "conforme").length}/${(ultGran.dados.linhas || []).filter((l) => l.sit).length}` : "—"} r="Peneiras conformes (últ.)" cor={ultGran ? (SIT[ultGran.situacao] || SIT.atencao).cor : C.mut} />
        <Kpi v={`${tonDesde.toFixed(0)} t`} r={freqTon ? `Desde últ. ensaio (freq. ${freqTon} t)` : "Desde últ. ensaio"} cor={ensaioDevido ? C.red : C.navy} />
      </div>
      {ensaioDevido && <Cartao style={{ background: C.redBg, borderColor: C.red }}><div style={{ color: C.red, fontWeight: 700, fontSize: 13.5 }}>⏰ Ensaio devido: produção desde o último ensaio ({tonDesde.toFixed(0)} t) atingiu a frequência configurada de {freqTon} t.</div></Cartao>}
      {!ensaios.length && cargas.length > 0 && <Cartao style={{ background: C.warnBg }}><div style={{ color: C.amber, fontWeight: 700, fontSize: 13.5 }}>⚠️ Produção do dia ainda sem cobertura de ensaio.</div></Cartao>}

      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 8 }}>Situação por eixo (sem selo único)</div>
        {eixos.map(([nome, s]) => (
          <div key={nome} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px dashed ${C.line}`, fontSize: 13.5 }}>
            <span style={{ color: C.mut }}>{nome}</span>
            {s === "pendente" || s == null ? <span style={{ fontWeight: 700, color: C.mut }}>Pendente</span> : <SeloSit s={s} />}
          </div>
        ))}
      </Cartao>

      <Cartao>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontWeight: 800, color: C.navy }}>📝 Minuta de análise técnica</div>
          {analise?.aprovadoPor && <span style={{ fontSize: 11.5, fontWeight: 700, color: C.ok, background: C.okBg, padding: "3px 9px", borderRadius: 99 }}>Aprovada · {analise.aprovadoPor}</span>}
        </div>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={7} placeholder="Toque em “Gerar minuta” para redigir automaticamente a partir dos dados do dia — depois revise, edite e aprove."
          style={{ width: "100%", boxSizing: "border-box", fontFamily: F.body, fontSize: 14, padding: 11, borderRadius: 11, border: `1.5px solid ${C.line}`, resize: "vertical" }} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          <Btn tom="claro" onClick={gerar}>⚙️ Gerar minuta</Btn>
          <Btn tom="ok" onClick={aprovar} disabled={!texto.trim()}>✔ Aprovar análise</Btn>
        </div>
      </Cartao>

      <Btn tom="red" onClick={() => setImprimir(true)}>📄 Relatório diário da usina (PDF)</Btn>
      {imprimir && <RelatorioUsina obra={obra} dataRef={hojeISO()} cargas={cargas} ensaios={ensaios} projeto={projeto} analise={{ ...(analise || {}), texto }} fechar={() => setImprimir(false)} />}
    </>
  );
}

// ----------------------------------------------------------------------------
// Impressão (PDF via imprimir) — componentes de relatório
// ----------------------------------------------------------------------------
const linkRel = (tipo, obraId, data) => `${location.origin}/?rel=${tipo}&obra=${obraId}${data ? `&data=${data}` : ""}`;

const ehStandalone = () => (typeof window !== "undefined") &&
  (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true);

function Impressao({ children, fechar, link, estatico }) {
  const standalone = ehStandalone();
  if (estatico) {
    return (
      <div className="area-impressao" style={{ background: "#fff", minHeight: "100vh" }}>
        <div className="nao-imprimir" style={{ background: C.blueBg, color: C.navy, fontSize: 13.5, fontWeight: 600, padding: "12px 16px", lineHeight: 1.5 }}>
          📄 Para salvar em PDF: toque em <b>Compartilhar</b> (ícone ↑) → <b>Imprimir</b> → e depois em <b>Compartilhar</b> de novo para salvar ou enviar o PDF. No computador: <b>Ctrl+P</b>.
        </div>
        <div style={{ maxWidth: 780, margin: "0 auto", padding: "18px 20px 60px", fontFamily: F.body, color: C.ink }}>{children}</div>
      </div>
    );
  }
  return (
    <div className="area-impressao" style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 100, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
      <div className="nao-imprimir" style={{ position: "sticky", top: 0, display: "flex", gap: 8, padding: 10, background: C.navy, zIndex: 5, flexWrap: "wrap" }}>
        {standalone && link
          ? <a href={link} target="_blank" rel="noopener noreferrer" style={{ flex: 1, minWidth: 160, textDecoration: "none", textAlign: "center", background: C.red, color: "#fff", fontFamily: F.body, fontWeight: 700, fontSize: 15, borderRadius: 12, padding: "13px 18px" }}>📤 Exportar / salvar PDF</a>
          : <Btn tom="red" cheio={false} onClick={() => window.print()} style={{ flex: 1, minWidth: 160 }}>📤 Exportar / salvar PDF</Btn>}
        <Btn tom="claro" cheio={false} onClick={fechar} style={{ padding: "13px 18px" }}>Fechar</Btn>
      </div>
      {standalone && link && <div className="nao-imprimir" style={{ background: C.warnBg, color: C.amber, fontSize: 12.5, fontWeight: 600, padding: "9px 14px" }}>O iPhone só gera PDF fora do app instalado — o botão acima abre este relatório no navegador, onde o PDF é gerado.</div>}
      <div style={{ maxWidth: 780, margin: "0 auto", padding: "18px 20px 60px", fontFamily: F.body, color: C.ink }}>{children}</div>
    </div>
  );
}
const tabTh = { textAlign: "left", padding: "5px 6px", fontSize: 10.5, color: "#fff", background: C.navy };
const tabTd = { padding: "5px 6px", fontSize: 11, borderBottom: `1px solid ${C.line}` };
const secRel = { fontFamily: F.disp, fontWeight: 800, fontSize: 14, color: C.navy, textTransform: "uppercase", borderBottom: `2px solid ${C.red}`, padding: "3px 0", margin: "16px 0 8px" };

function CabecalhoRel({ titulo, numero, obra, dataRef }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: `3px solid ${C.navy}`, paddingBottom: 10 }}>
        <Logo s={46} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 22, color: C.navy }}>SOLOCONTROL</div>
          <div style={{ fontSize: 11, color: C.mut }}>Qualidade que constrói confiança · Controle tecnológico de massa asfáltica</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 15, color: C.red }}>{titulo}</div>
          <div style={{ fontSize: 11.5, fontWeight: 700 }}>{numero}</div>
          <div style={{ fontSize: 11.5, color: C.mut }}>{fmtBR(dataRef)}</div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: C.mut, marginTop: 6 }}>{obra?.nome} · {obra?.contratante || "—"} · {obra?.local || "—"}</div>
    </>
  );
}
function FotosRel({ fotos, titulo }) {
  const fs = (fotos || []).filter((f) => f.url);
  if (!fs.length) return null;
  return (
    <>
      <div style={secRel}>{titulo}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {fs.map((f) => (
          <figure key={f.id} style={{ margin: 0, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", breakInside: "avoid" }}>
            <img src={f.url} alt="" style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }} />
            <figcaption style={{ fontSize: 8.5, padding: "3px 6px", color: C.mut }}>{f.legenda || "Registro"}</figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}
function EnsaiosRel({ ensaios }) {
  if (!ensaios.length) return null;
  return (
    <>
      {ensaios.filter((e) => e.tipo === "teor").map((e) => (
        <div key={e.id} style={{ breakInside: "avoid" }}>
          <div style={secRel}>Ensaio de teor de ligante · {e.codigo}</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
            <tr><td style={tabTd}><b>Método</b></td><td style={tabTd}>{e.metodo}</td><td style={tabTd}><b>Equipamento</b></td><td style={tabTd}>{e.equipamento ? `${e.equipamento.nome} · patr. ${e.equipamento.patrimonio} · calib. ${fmtBR(e.equipamento.validade)}${e.equipamento.vencida ? " (VENCIDA)" : ""}` : "—"}</td></tr>
            <tr><td style={tabTd}><b>Memória de cálculo</b></td><td style={tabTd} colSpan={3}>{e.resultado.memoria} = <b>{e.resultado.teor.toFixed(2)}%</b> · fórmula {e.resultado.versaoFormula}</td></tr>
            <tr><td style={tabTd}><b>Projeto</b></td><td style={tabTd}>{e.resultado.tp}% ± {e.resultado.tol}%</td><td style={tabTd}><b>Desvio</b></td><td style={tabTd}>{e.resultado.desvio > 0 ? "+" : ""}{e.resultado.desvio}% · <b style={{ color: (SIT[e.situacao] || SIT.atencao).cor }}>{(SIT[e.situacao] || SIT.atencao).rot.toUpperCase()}</b></td></tr>
            <tr><td style={tabTd}><b>Representatividade</b></td><td style={tabTd} colSpan={3}>{e.vinculo?.tipo === "lote" ? "Lote/jornada de produção" : e.vinculo?.tipo === "intervalo" ? "Intervalo de cargas" : "Carga específica"}{e.vinculo?.justificativa ? ` — ${e.vinculo.justificativa}` : ""} · Técnico: {e.tecnico} · {e.horaEnsaio}</td></tr>
          </tbody></table>
        </div>
      ))}
      {ensaios.filter((e) => e.tipo === "granulometria").map((e) => (
        <div key={e.id} style={{ breakInside: "avoid" }}>
          <div style={secRel}>Granulometria do agregado recuperado · {e.codigo}</div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}>
            <thead><tr>{["Peneira","Faixa norma","Projeto","Tol ±","Lim. aplicado","Medido","Dif.","Situação"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
            <tbody>{(e.dados.linhas || []).map((l, i) => (
              <tr key={i}>
                <td style={tabTd}><b>{l.nome}</b></td><td style={tabTd}>{l.limInf}–{l.limSup}</td><td style={tabTd}>{l.projeto || "—"}</td><td style={tabTd}>{l.tol}</td>
                <td style={tabTd}>{l.apInf != null && isFinite(l.apInf) ? `${Math.round(l.apInf * 10) / 10}–${Math.round(l.apSup * 10) / 10}` : "—"}</td>
                <td style={tabTd}><b>{l.passante != null ? `${l.passante}%` : "—"}</b></td><td style={tabTd}>{l.dif != null ? `${l.dif > 0 ? "+" : ""}${l.dif}` : "—"}</td>
                <td style={{ ...tabTd, fontWeight: 800, color: l.sit ? SIT[l.sit].cor : C.mut }}>{l.sit ? SIT[l.sit].rot : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
          <div style={{ fontSize: 11, color: C.mut, marginBottom: 6 }}>Massa seca {e.dados.massaSeca} g · Σ retidas + fundo {e.dados.soma} g · perda {e.dados.perda}% · Técnico: {e.tecnico} · {e.horaEnsaio}</div>
          <CurvaGran linhas={e.dados.linhas || []} />
        </div>
      ))}
    </>
  );
}

// ----------------------------------------------------------------------------
// Relatório diário da USINA (mantém e amplia o relatório do app atual)
// ----------------------------------------------------------------------------
function RelatorioUsina({ obra, dataRef, cargas, ensaios, projeto, analise, fechar, estatico }) {
  const ton = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const temps = cargas.map((c) => c.tempSaida).filter((v) => v != null);
  const retidas = cargas.filter((c) => c.conformeSaida === false);
  const eixos = eixosConformidade({ cargas, ensaios });
  const numero = `RU-${dataRef.replace(/-/g, "")}-${(obra?.nome || "OB").replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase()}`;
  const verif = `${numero}·${cargas.length}C·${ensaios.length}E·${ton.toFixed(0)}T`;
  const historico = ensaios.flatMap((e) => (e.historico || []).map((h) => `${e.codigo} corrigido por ${h.por} em ${fmtBR(h.em?.slice(0, 10))}`));
  return (
    <Impressao fechar={fechar} link={linkRel("usina", obra?.id, dataRef)} estatico={estatico}>
      <CabecalhoRel titulo="RELATÓRIO DIÁRIO DA USINA" numero={numero} obra={obra} dataRef={dataRef} />
      <div style={secRel}>1 · Situação geral (por eixo)</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        {eixos.map(([nome, s]) => (
          <tr key={nome}><td style={tabTd}>{nome}</td><td style={{ ...tabTd, fontWeight: 800, color: s && s !== "pendente" ? SIT[s].cor : C.mut, textAlign: "right" }}>{s && s !== "pendente" ? SIT[s].rot.toUpperCase() : "PENDENTE"}</td></tr>
        ))}
      </tbody></table>
      <div style={secRel}>2 · Identificação</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        <tr><td style={tabTd}><b>Usina</b></td><td style={tabTd}>{cargas[0]?.usina || ensaios[0]?.usina || "—"}</td><td style={tabTd}><b>Jornada</b></td><td style={tabTd}>{[...new Set(ensaios.map((e) => e.jornada))].join(" / ") || "Diurna"}</td></tr>
        <tr><td style={tabTd}><b>Projeto de mistura</b></td><td style={tabTd}>{projeto ? `${projeto.codigo} · ${projeto.faixa} · ${projeto.tipoLigante} · teor ${projeto.teorProjeto}% ± ${projeto.tolTeor}%` : "—"}</td><td style={tabTd}><b>Norma</b></td><td style={tabTd}>{projeto?.norma || "—"}</td></tr>
        <tr><td style={tabTd}><b>Técnico(s)</b></td><td style={tabTd}>{[...new Set([...cargas.map((c) => c.criadoPor?.nome), ...ensaios.map((e) => e.tecnico)].filter(Boolean))].join(", ") || "—"}</td><td style={tabTd}><b>Espessura projeto</b></td><td style={tabTd}>{obra?.espessuraProjeto ? `${obra.espessuraProjeto} cm` : "—"}</td></tr>
      </tbody></table>
      <div style={secRel}>3 · Resumo da produção</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}><tbody><tr>
        <td style={tabTd}><b>Cargas:</b> {cargas.length}</td>
        <td style={tabTd}><b>Liberadas:</b> {cargas.length - retidas.length}</td>
        <td style={tabTd}><b>Retidas:</b> {retidas.length}</td>
        <td style={tabTd}><b>Massa total:</b> {ton.toFixed(1)} t</td>
        <td style={tabTd}><b>Temp. mín/méd/máx:</b> {temps.length ? `${Math.min(...temps)} / ${(temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1)} / ${Math.max(...temps)} °C` : "—"}</td>
      </tr></tbody></table>
      <GraficoTemp cargas={cargas} />
      <div style={secRel}>4 · Cargas expedidas</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Nº","Placa","NF","Ton (t)","Saída","Temp (°C)","Situação"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
        <tbody>{cargas.map((c, i) => (
          <tr key={c.id}><td style={tabTd}>{String(i + 1).padStart(2, "0")}</td><td style={tabTd}><b>{c.placa}</b></td><td style={tabTd}>{c.nf || "—"}</td><td style={tabTd}>{c.tonelagem}</td><td style={tabTd}>{c.horaSaida}</td><td style={tabTd}>{c.tempSaida}</td>
            <td style={{ ...tabTd, fontWeight: 800, color: c.conformeSaida === false ? C.red : C.ok }}>{c.conformeSaida === false ? "RETIDA" : "LIBERADA"}</td></tr>
        ))}</tbody>
      </table>
      <EnsaiosRel ensaios={ensaios} />
      <FotosRel titulo="Registro fotográfico dos ensaios" fotos={ensaios.flatMap((e) => e.fotos || [])} />
      <FotosRel titulo="Registro fotográfico das cargas" fotos={cargas.flatMap((c) => c.fotosUsina || [])} />
      <div style={secRel}>Análise técnica</div>
      {!analise?.aprovadoPor && <div style={{ fontSize: 10.5, fontWeight: 800, color: C.amber, marginBottom: 4 }}>MINUTA — sujeita a revisão e aprovação do responsável técnico</div>}
      <div style={{ fontSize: 11.5, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{analise?.texto || "Sem análise registrada."}</div>
      {historico.length > 0 && <><div style={secRel}>Histórico de revisão</div><div style={{ fontSize: 10.5, color: C.mut }}>{historico.join(" · ")}</div></>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 30, marginTop: 40, breakInside: "avoid" }}>
        {["Fiscal de qualidade — usina", "Coordenação Solocontrol"].map((r) => (
          <div key={r} style={{ textAlign: "center" }}><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 5, fontSize: 11 }}>{r}</div></div>
        ))}
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Critério adotado conforme projeto e especificação contratual cadastrados. Documento gerado pelo sistema Solocontrol em {fmtDataHora()} · Código de verificação: {verif}
      </div>
    </Impressao>
  );
}

// ----------------------------------------------------------------------------
// Relatório diário CONSOLIDADO (usina + transporte + pista + laboratório)
// ----------------------------------------------------------------------------
function RelatorioDiario({ obra, dataRef, cargas, fech, fechar, estatico }) {
  const [ensaios, setEnsaios] = useState([]);
  const [analise, setAnalise] = useState(null);
  useEffect(() => {
    getDocs(query(collection(db, "ensaios"), where("obraId", "==", obra.id), where("dataRef", "==", dataRef))).then((s) => {
      const a = s.docs.map((d) => ({ id: d.id, ...d.data() })); a.sort((x, y) => (x.criadoEm || "").localeCompare(y.criadoEm || "")); setEnsaios(a);
    }).catch(() => {});
    getDoc(doc(db, "analises", `${obra.id}_${dataRef}`)).then((s) => s.exists() && setAnalise(s.data())).catch(() => {});
  }, [obra.id, dataRef]);
  const ton = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const perdas = cargas.map((c) => c.transporte?.perda).filter((v) => v != null);
  const tempos = cargas.map((c) => c.transporte?.minutos).filter((v) => v != null);
  const med = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const ncs = cargas.filter((c) => c.status === "nao_conforme" || c.conformeSaida === false);
  const numero = `RD-${dataRef.replace(/-/g, "")}-${(obra?.nome || "OB").replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase()}`;
  const ensGC = (fech?.ensaios || []).filter((r) => num(r.gc) != null);
  return (
    <Impressao fechar={fechar} link={linkRel("diario", obra?.id, dataRef)} estatico={estatico}>
      <CabecalhoRel titulo="RELATÓRIO DIÁRIO CONSOLIDADO" numero={numero} obra={obra} dataRef={dataRef} />
      <div style={secRel}>1 · Resumo executivo</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody><tr>
        <td style={tabTd}><b>Cargas:</b> {cargas.length}</td>
        <td style={tabTd}><b>Massa aplicada:</b> {ton.toFixed(1)} t</td>
        <td style={tabTd}><b>Tempo médio usina→obra:</b> {fmtMin(med(tempos) != null ? Math.round(med(tempos)) : null)}</td>
        <td style={tabTd}><b>Perda térmica média:</b> {med(perdas) != null ? `${med(perdas).toFixed(1)} °C` : "—"}</td>
        <td style={tabTd}><b>Não conformidades:</b> {ncs.length}</td>
      </tr></tbody></table>
      <div style={secRel}>2 · Rastreabilidade carga a carga (usina → pista)</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Nº","Placa/NF","Ton","Saída","Chegada","Perda °C","Transp.","Aplic. °C","Trecho/estaca","Esp. (cm)","Situação"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
        <tbody>{cargas.map((c, i) => (
          <tr key={c.id}>
            <td style={tabTd}>{String(i + 1).padStart(2, "0")}</td>
            <td style={tabTd}><b>{c.placa}</b><br /><span style={{ color: C.mut }}>{c.nf || "—"}</span></td>
            <td style={tabTd}>{c.tonelagem}</td>
            <td style={tabTd}>{c.horaSaida}<br />{c.tempSaida}°</td>
            <td style={tabTd}>{c.chegada ? <>{c.chegada.hora}<br />{c.chegada.temp}°</> : "—"}</td>
            <td style={tabTd}>{c.transporte?.perda ?? "—"}</td>
            <td style={tabTd}>{fmtMin(c.transporte?.minutos)}</td>
            <td style={tabTd}>{c.descarga?.tempAplicacao ?? "—"}</td>
            <td style={tabTd}>{c.descarga?.trecho || "—"}</td>
            <td style={tabTd}>{c.descarga?.espessura || "—"}</td>
            <td style={{ ...tabTd, fontWeight: 800, color: STATUS[c.status]?.cor }}>{STATUS[c.status]?.rot}</td>
          </tr>
        ))}</tbody>
      </table>
      <div style={{ fontSize: 10, color: C.mut, marginTop: 4 }}>Critérios: saída {LIMITES.tempSaidaMin}–{LIMITES.tempSaidaMax} °C · aplicação ≥ {LIMITES.tempAplicMin} °C · conforme projeto e especificação contratual cadastrados.</div>
      <EnsaiosRel ensaios={ensaios} />
      {fech && (
        <>
          <div style={secRel}>Encerramento do dia na pista</div>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}><tbody>
            <tr><td style={tabTd}><b>Retorno de caminhões</b></td><td style={tabTd}>{fech.retorno === "sim" ? `Sim — ${fech.caminhoesRetorno || "?"} caminhão(ões) para concluir o dia` : fech.retorno === "nao" ? "Não — dia encerrado" : "—"}</td>
              <td style={tabTd}><b>Fechado por</b></td><td style={tabTd}>{fech.fechadoPor || "—"}</td></tr>
            {fech.obs && <tr><td style={tabTd}><b>Observações</b></td><td style={tabTd} colSpan={3}>{fech.obs}</td></tr>}
          </tbody></table>
          {ensGC.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}>
              <thead><tr>{["Estaca/local","GC (%)","Espessura (cm)","Densidade (g/cm³)","Situação"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
              <tbody>{ensGC.map((r, i) => (
                <tr key={i}><td style={tabTd}>{r.estaca || "—"}</td><td style={tabTd}><b>{r.gc}</b></td><td style={tabTd}>{r.esp || "—"}</td><td style={tabTd}>{r.dens || "—"}</td>
                  <td style={{ ...tabTd, fontWeight: 800, color: num(r.gc) >= LIMITES.gcMin ? C.ok : C.red }}>{num(r.gc) >= LIMITES.gcMin ? "CONFORME" : "NÃO CONFORME"}</td></tr>
              ))}</tbody>
            </table>
          )}
          {(fech.imprimacao || []).some((r) => calcImprim(r, fech.imprimCfg)) && (
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}>
              <thead><tr>{["Imprimação (bandeja)", "Peso 01", "Peso 02", "Taxa (l/m²)", "Situação"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
              <tbody>{fech.imprimacao.map((r, i) => { const c = calcImprim(r, fech.imprimCfg); return c && (
                <tr key={i}><td style={tabTd}>{r.trecho || "—"}</td><td style={tabTd}>{r.p1}</td><td style={tabTd}>{r.p2}</td><td style={{ ...tabTd, fontWeight: 800 }}>{c.taxa.toFixed(2)}</td>
                  <td style={{ ...tabTd, fontWeight: 800, color: c.sit === "conforme" ? C.ok : C.red }}>{c.sit === "conforme" ? "CONFORME" : "NÃO CONFORME"}</td></tr>
              ); })}</tbody>
            </table>
          )}
          {(fech.amostras || []).filter((a) => a.ident || a.placa).length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Amostra","Placa","NF","Pista/trecho"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
              <tbody>{fech.amostras.filter((a) => a.ident || a.placa).map((a, i) => (
                <tr key={i}><td style={tabTd}><b>{a.ident || "—"}</b></td><td style={tabTd}>{a.placa || "—"}</td><td style={tabTd}>{a.nf || "—"}</td><td style={tabTd}>{a.trecho || "—"}</td></tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
      <FotosRel titulo="Registro fotográfico — usina" fotos={cargas.flatMap((c) => c.fotosUsina || [])} />
      <FotosRel titulo="Registro fotográfico — ensaios" fotos={ensaios.flatMap((e) => e.fotos || [])} />
      <FotosRel titulo="Registro fotográfico — pista" fotos={[...cargas.flatMap((c) => [...(c.chegada?.fotos || []), ...(c.descarga?.fotos || [])]), ...(fech?.fotos || []), ...(fech?.fotosImprimacao || [])]} />
      <div style={secRel}>Análise técnica</div>
      {!analise?.aprovadoPor && <div style={{ fontSize: 10.5, fontWeight: 800, color: C.amber, marginBottom: 4 }}>MINUTA — sujeita a revisão e aprovação do responsável técnico</div>}
      <div style={{ fontSize: 11.5, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{analise?.texto || "Sem análise registrada para a data."}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 22, marginTop: 40, breakInside: "avoid" }}>
        {["Fiscal de qualidade — usina", "Fiscal de qualidade — pista", "Coordenação Solocontrol"].map((r) => (
          <div key={r} style={{ textAlign: "center" }}><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 5, fontSize: 10.5 }}>{r}</div></div>
        ))}
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Documento gerado pelo sistema Solocontrol em {fmtDataHora()} · Nº {numero} · Registros assinados digitalmente por usuário autenticado.
      </div>
    </Impressao>
  );
}

// ----------------------------------------------------------------------------
// Resumo geral da OBRA (do início ao fim da execução)
// ----------------------------------------------------------------------------
function ResumoObra({ obra, cargas, fechs, fechar, estatico }) {
  const ord = [...cargas].sort((a, b) => (a.dataRef + a.horaSaida).localeCompare(b.dataRef + b.horaSaida));
  const dias = [...new Set(ord.map((c) => c.dataRef))].sort();
  const ton = ord.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const perdas = ord.map((c) => c.transporte?.perda).filter((v) => v != null);
  const tempos = ord.map((c) => c.transporte?.minutos).filter((v) => v != null);
  const med = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const enc = ord.filter((c) => c.status === "concluida" || c.status === "nao_conforme");
  const conf = enc.length ? Math.round((enc.filter((c) => c.status === "concluida").length / enc.length) * 100) : null;
  const gcs = fechs.flatMap((f) => (f.ensaios || []).map((r) => num(r.gc)).filter((v) => v != null));
  const amostras = fechs.flatMap((f) => (f.amostras || []).filter((a) => a.ident || a.placa));
  const numero = `RG-${(obra?.nome || "OB").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase()}`;
  return (
    <Impressao fechar={fechar} link={linkRel("resumo", obra?.id)} estatico={estatico}>
      <CabecalhoRel titulo="RESUMO GERAL DA OBRA" numero={numero} obra={obra} dataRef={obra.dataConclusao || hojeISO()} />
      <div style={secRel}>1 · Síntese da execução</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        <tr><td style={tabTd}><b>Período</b></td><td style={tabTd}>{fmtBR(dias[0])} → {fmtBR(dias[dias.length - 1])} ({dias.length} dia(s) de aplicação)</td>
          <td style={tabTd}><b>Status</b></td><td style={tabTd}>{obra.status === "concluida" ? `Concluída em ${fmtBR(obra.dataConclusao)}` : "Em andamento"}</td></tr>
        <tr><td style={tabTd}><b>Massa total aplicada</b></td><td style={tabTd}><b>{ton.toFixed(1)} t</b> em {ord.length} cargas</td>
          <td style={tabTd}><b>Conformidade das cargas</b></td><td style={tabTd}>{conf == null ? "—" : `${conf}%`}</td></tr>
        <tr><td style={tabTd}><b>Perda térmica média</b></td><td style={tabTd}>{med(perdas) != null ? `${med(perdas).toFixed(1)} °C` : "—"}</td>
          <td style={tabTd}><b>Tempo médio usina→obra</b></td><td style={tabTd}>{fmtMin(med(tempos) != null ? Math.round(med(tempos)) : null)}</td></tr>
        <tr><td style={tabTd}><b>Ensaios de pista (GC)</b></td><td style={tabTd}>{gcs.length ? `${gcs.length} determinações · média ${(gcs.reduce((a, b) => a + b, 0) / gcs.length).toFixed(1)}% · mín ${Math.min(...gcs)}%` : "—"}</td>
          <td style={tabTd}><b>Amostras p/ laboratório</b></td><td style={tabTd}>{amostras.length}</td></tr>
      </tbody></table>
      <div style={secRel}>2 · Evolução diária</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Data","Cargas","Massa (t)","Perda média °C","Não conf.","Dia fechado por"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
        <tbody>{dias.map((d) => {
          const cs = ord.filter((c) => c.dataRef === d);
          const pd = cs.map((c) => c.transporte?.perda).filter((v) => v != null);
          const fe = fechs.find((f) => f.dataRef === d);
          return (
            <tr key={d}><td style={tabTd}><b>{fmtBR(d)}</b></td><td style={tabTd}>{cs.length}</td><td style={tabTd}>{cs.reduce((s, c) => s + (c.tonelagem || 0), 0).toFixed(1)}</td>
              <td style={tabTd}>{pd.length ? (pd.reduce((a, b) => a + b, 0) / pd.length).toFixed(1) : "—"}</td>
              <td style={{ ...tabTd, color: C.red, fontWeight: 700 }}>{cs.filter((c) => c.status === "nao_conforme").length || "—"}</td>
              <td style={tabTd}>{fe?.fechadoPor || "—"}</td></tr>
          );
        })}</tbody>
      </table>
      {amostras.length > 0 && (
        <>
          <div style={secRel}>3 · Amostras encaminhadas ao laboratório</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Amostra","Placa","NF","Pista/trecho"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
            <tbody>{amostras.map((a, i) => (
              <tr key={i}><td style={tabTd}><b>{a.ident || "—"}</b></td><td style={tabTd}>{a.placa || "—"}</td><td style={tabTd}>{a.nf || "—"}</td><td style={tabTd}>{a.trecho || "—"}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 30, marginTop: 44, breakInside: "avoid" }}>
        {["Coordenação Solocontrol", "Engenheiro responsável"].map((r) => (
          <div key={r} style={{ textAlign: "center" }}><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 5, fontSize: 11 }}>{r}</div></div>
        ))}
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Documento gerado pelo sistema Solocontrol em {fmtDataHora()} · Consolida {ord.length} cargas e {fechs.length} fechamento(s) diário(s) registrados em nuvem.
      </div>
    </Impressao>
  );
}

// ============================================================================
// RAIZ DO APP
// ============================================================================
export default function App() {
  const linkRelatorio = useMemo(() => {
    if (typeof window === "undefined") return null;
    const p = new URLSearchParams(location.search);
    const tipo = p.get("rel");
    return tipo && p.get("obra") ? { tipo, obraId: p.get("obra"), data: p.get("data") || hojeISO() } : null;
  }, []);
  const [user, setUser] = useState(undefined);
  const [perfil, setPerfil] = useState(null);
  const [aba, setAba] = useState("");
  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u || null)), []);
  useEffect(() => {
    if (!user) { setPerfil(null); return; }
    return onSnapshot(doc(db, "usuarios", user.uid), (s) => {
      if (!s.exists()) return setPerfil({ uid: user.uid, semPerfil: true });
      setPerfil({ uid: user.uid, ...s.data() });
    });
  }, [user?.uid]);

  const abas = useMemo(() => {
    if (!perfil) return [];
    if (perfil.papel === "coordenador") return [
      { id: "painel", ico: "📊", rot: "Painel" }, { id: "obras", ico: "🏗️", rot: "Obras" },
      { id: "equipe", ico: "👥", rot: "Equipe" }, { id: "relatorios", ico: "📄", rot: "Relatórios" }];
    if (perfil.papel === "usina") return [
      { id: "nova", ico: "➕", rot: "Nova carga" }, { id: "dia", ico: "🚚", rot: "Cargas" },
      { id: "ensaios", ico: "🧪", rot: "Ensaios" }, { id: "resumo", ico: "📊", rot: "Resumo" }];
    if (perfil.papel === "diretoria") return [{ id: "tv", ico: "📺", rot: "Painel ao vivo" }];
    if (perfil.papel === "ambos") return [
      { id: "nova", ico: "➕", rot: "Nova" }, { id: "dia", ico: "🚚", rot: "Cargas" },
      { id: "ensaios", ico: "🧪", rot: "Ensaios" }, { id: "resumo", ico: "📊", rot: "Resumo" },
      { id: "boletins", ico: "📋", rot: "Boletins" }, { id: "fechamento", ico: "🔒", rot: "Fechar" }];
    return [{ id: "boletins", ico: "📋", rot: "Boletins" }, { id: "fechamento", ico: "🔒", rot: "Fechar dia" }];
  }, [perfil?.papel]);
  useEffect(() => { if (abas.length && !abas.find((a) => a.id === aba)) setAba(abas[0].id); }, [abas]);

  if (user === undefined) return null;
  if (!user) return <><EstiloGlobal /><TelaLogin /></>;
  if (!perfil) return null;
  if (perfil.semPerfil) return <Aviso txt="Seu acesso ainda não tem perfil configurado. Peça ao coordenador para cadastrar você em Equipe." />;
  if (perfil.ativo === false) return <Aviso txt="Acesso desativado pela coordenação." sair />;
  if (linkRelatorio) return <><EstiloGlobal /><RelatorioPorLink {...linkRelatorio} /></>;

  return (
    <>
      <EstiloGlobal />
      <Shell perfil={perfil} abas={abas} aba={aba} setAba={setAba}>
        {perfil.papel === "coordenador" && <TelaCoordenador perfil={perfil} aba={aba} />}
        {(perfil.papel === "usina" || perfil.papel === "ambos") && ["nova", "dia", "ensaios", "resumo"].includes(aba) && (
          aba === "nova" ? <UsinaNovaCarga perfil={perfil} /> :
          aba === "dia" ? <UsinaCargasDia perfil={perfil} /> :
          aba === "ensaios" ? <EnsaiosUsina perfil={perfil} /> : <ResumoUsina perfil={perfil} />
        )}
        {(perfil.papel === "obra" || perfil.papel === "ambos") && ["boletins", "fechamento"].includes(aba) && <TelaObra perfil={perfil} aba={aba} />}
        {perfil.papel === "diretoria" && <PainelTV />}
      </Shell>
    </>
  );
}
const Aviso = ({ txt, sair }) => (
  <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: C.bg, fontFamily: F.body, padding: 20 }}>
    <div style={{ textAlign: "center", maxWidth: 340 }}>
      <Logo s={52} />
      <div style={{ marginTop: 12, color: C.ink, fontWeight: 600 }}>{txt}</div>
      <div style={{ marginTop: 14 }}><Btn tom="claro" onClick={() => signOut(auth)}>Sair</Btn></div>
    </div>
  </div>
);
const EstiloGlobal = () => (
  <style>{`
    * { -webkit-tap-highlight-color: transparent; }
    input, select, textarea { outline-color: ${C.navy}; }
    @media print {
      body * { visibility: hidden; }
      .area-impressao, .area-impressao * { visibility: visible; }
      .area-impressao { position: static !important; inset: auto !important; overflow: visible !important; height: auto !important; }
      html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
      .nao-imprimir { display: none !important; }
      @page { size: A4; margin: 12mm; }
    }
  `}</style>
);

// ============================================================================
// MODO TV — Painel executivo ao vivo (diretoria)
// ============================================================================
function RelogioAoVivo() {
  const [h, setH] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setH(new Date()), 1000); return () => clearInterval(t); }, []);
  return <>{h.toLocaleTimeString("pt-BR")}</>;
}

function PainelTV({ fechar }) {
  const cargas = useCargasDia(hojeISO());
  const obras = useObras();
  const [fechs, setFechs] = useState([]);
  useEffect(() => onSnapshot(query(collection(db, "fechamentos"), where("dataRef", "==", hojeISO())), (s) =>
    setFechs(s.docs.map((d) => ({ id: d.id, ...d.data() })))), []);

  const ton = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const transito = cargas.filter((c) => c.status === "em_transito");
  const enc = cargas.filter((c) => c.status === "concluida" || c.status === "nao_conforme");
  const ncs = cargas.filter((c) => c.status === "nao_conforme" || c.conformeSaida === false);
  const conf = enc.length ? Math.round((enc.filter((c) => c.status === "concluida").length / enc.length) * 100) : null;
  const perdas = cargas.map((c) => c.transporte?.perda).filter((v) => v != null);
  const tempos = cargas.map((c) => c.transporte?.minutos).filter((v) => v != null);
  const med = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  const Big = ({ v, r, cor }) => (
    <div style={{ background: "rgba(255,255,255,.06)", borderRadius: 20, padding: "22px 12px", textAlign: "center", border: "1px solid rgba(255,255,255,.09)" }}>
      <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: "clamp(34px, 5vw, 58px)", lineHeight: 1, color: cor || "#fff" }}>{v}</div>
      <div style={{ fontSize: "clamp(11px, 1.4vw, 15px)", fontWeight: 700, color: "#8E9AC6", marginTop: 10, textTransform: "uppercase", letterSpacing: 1 }}>{r}</div>
    </div>
  );
  const Sec = ({ t, children }) => (
    <div style={{ background: "rgba(255,255,255,.05)", borderRadius: 20, padding: 18, border: "1px solid rgba(255,255,255,.08)" }}>
      <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 17, color: "#AEB8E0", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12 }}>{t}</div>
      {children}
    </div>
  );

  return (
    <div className="nao-imprimir" style={{ position: "fixed", inset: 0, zIndex: 90, background: "linear-gradient(160deg, #0B1230 0%, #101A45 100%)", overflowY: "auto", fontFamily: F.body, padding: "18px clamp(14px, 3vw, 40px) 40px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
        <Logo s={46} />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: "clamp(20px, 2.6vw, 30px)", color: "#fff", letterSpacing: 1 }}>SOLOCONTROL · PAINEL EXECUTIVO</div>
          <div style={{ color: "#8E9AC6", fontSize: 14, fontWeight: 600 }}>{fmtBR(hojeISO())} · <RelogioAoVivo /> · <span style={{ color: "#7CE0A3" }}>● AO VIVO</span></div>
        </div>
        {fechar
          ? <button onClick={fechar} style={{ background: "rgba(255,255,255,.12)", border: "none", color: "#fff", borderRadius: 12, padding: "12px 20px", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>✕ Fechar</button>
          : <button onClick={() => signOut(auth)} style={{ background: "rgba(255,255,255,.12)", border: "none", color: "#fff", borderRadius: 12, padding: "12px 20px", fontSize: 14, fontWeight: 800, cursor: "pointer" }}>Sair</button>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14, marginBottom: 16 }}>
        <Big v={`${ton.toFixed(1)} t`} r="Massa aplicada hoje" />
        <Big v={cargas.length} r="Cargas no dia" />
        <Big v={transito.length} r="Em trânsito agora" cor={transito.length ? "#FFC24B" : "#fff"} />
        <Big v={conf == null ? "—" : `${conf}%`} r="Conformidade" cor={conf == null ? "#fff" : conf < 100 ? "#FF7A7A" : "#7CE0A3"} />
        <Big v={med(perdas) == null ? "—" : `${med(perdas).toFixed(0)}°C`} r="Perda térmica média" />
        <Big v={med(tempos) == null ? "—" : fmtMin(Math.round(med(tempos)))} r="Usina → pista (médio)" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
        <Sec t="🚚 Em trânsito agora">
          {!transito.length && <div style={{ color: "#5C6890", fontSize: 15 }}>Nenhum caminhão em trânsito neste momento.</div>}
          {transito.map((c) => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.07)", color: "#fff", fontSize: "clamp(14px, 1.6vw, 18px)" }}>
              <span style={{ fontWeight: 800 }}>{c.placa} <span style={{ color: "#8E9AC6", fontWeight: 600 }}>→ {c.obraNome}</span></span>
              <span style={{ color: "#AEB8E0", fontWeight: 700, whiteSpace: "nowrap" }}>{c.horaSaida} · {c.tempSaida}°C{c.tonelagem != null ? ` · ${c.tonelagem} t` : ""}</span>
            </div>
          ))}
        </Sec>

        <Sec t="🏗️ Obras hoje">
          {obras.filter((o) => o.status === "ativa").map((o) => {
            const cs = cargas.filter((c) => c.obraId === o.id);
            const fe = fechs.find((x) => x.obraId === o.id);
            const t = cs.reduce((s, c) => s + (c.tonelagem || 0), 0);
            return (
              <div key={o.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.07)", fontSize: "clamp(14px, 1.6vw, 17px)" }}>
                <span style={{ color: "#fff", fontWeight: 700 }}>{o.nome}</span>
                <span style={{ whiteSpace: "nowrap", color: "#AEB8E0", fontWeight: 700 }}>
                  {cs.length} cargas · {t.toFixed(1)} t · {fe?.fechado ? <span style={{ color: "#7CE0A3" }}>dia fechado</span> : <span style={{ color: "#FFC24B" }}>em execução</span>}
                </span>
              </div>
            );
          })}
          {!obras.filter((o) => o.status === "ativa").length && <div style={{ color: "#5C6890", fontSize: 15 }}>Nenhuma obra ativa.</div>}
        </Sec>

        <Sec t="⚠️ Alertas de qualidade">
          {!ncs.length && <div style={{ color: "#7CE0A3", fontSize: 16, fontWeight: 700 }}>✅ Nenhuma não conformidade hoje.</div>}
          {ncs.map((c) => (
            <div key={c.id} style={{ color: "#FF9B9B", fontSize: "clamp(14px, 1.5vw, 16px)", fontWeight: 600, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.07)" }}>
              {c.obraNome} — {c.placa}: {c.conformeSaida === false ? `saída a ${c.tempSaida}°C (faixa ${LIMITES.tempSaidaMin}–${LIMITES.tempSaidaMax}°C)` : `aplicação a ${c.descarga?.tempAplicacao}°C (mín. ${LIMITES.tempAplicMin}°C)`}
            </div>
          ))}
        </Sec>
      </div>
    </div>
  );
}

// ============================================================================
// CARTA DE CONTROLE — tendência do teor de ligante e do grau de compactação
// ============================================================================
function ChartControle({ pontos, refs = [], titulo, unidade, w = 680, h = 250 }) {
  if (!pontos.length) return <div style={{ fontSize: 13, color: C.mut, padding: 10 }}>Sem dados registrados para o período.</div>;
  const vals = [...pontos.map((p) => p.y), ...refs.map((r) => r.v)];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.25, 0.2);
  const yMin = lo - pad, yMax = hi + pad;
  const mx = 46, my = 30;
  const X = (i) => mx + (pontos.length === 1 ? 0.5 : i / (pontos.length - 1)) * (w - mx - 16);
  const Y = (v) => h - my - ((v - yMin) / (yMax - yMin)) * (h - my - 16);
  return (
    <div style={{ breakInside: "avoid" }}>
      <div style={{ fontWeight: 800, fontSize: 13.5, color: C.navy, margin: "10px 0 6px" }}>{titulo}</div>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", background: "#fff", border: `1px solid ${C.line}`, borderRadius: 10 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const v = yMin + f * (yMax - yMin);
          return <g key={f}><line x1={mx} x2={w - 16} y1={Y(v)} y2={Y(v)} stroke="#EDF0F7" /><text x={mx - 6} y={Y(v) + 4} fontSize="10" fill={C.mut} textAnchor="end">{v.toFixed(1)}</text></g>;
        })}
        {refs.map((r, i) => (
          <g key={i}>
            <line x1={mx} x2={w - 16} y1={Y(r.v)} y2={Y(r.v)} stroke={r.cor} strokeDasharray={r.solida ? "" : "6 4"} strokeWidth="1.6" />
            <text x={w - 18} y={Y(r.v) - 4} fontSize="9.5" fill={r.cor} textAnchor="end" fontWeight="700">{r.rot}</text>
          </g>
        ))}
        <polyline points={pontos.map((p, i) => `${X(i)},${Y(p.y)}`).join(" ")} fill="none" stroke={C.navy} strokeWidth="2" />
        {pontos.map((p, i) => (
          <g key={i}>
            <circle cx={X(i)} cy={Y(p.y)} r="4" fill={p.fora ? C.red : C.ok} stroke="#fff" strokeWidth="1.2" />
            <text x={X(i)} y={h - 8} fontSize="8.5" fill={C.mut} textAnchor="middle">{p.rot}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function CartaControle({ obra, fechar, estatico }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    (async () => {
      const [es, fs] = await Promise.all([
        getDocs(query(collection(db, "ensaios"), where("obraId", "==", obra.id))),
        getDocs(query(collection(db, "fechamentos"), where("obraId", "==", obra.id))),
      ]);
      const teores = es.docs.map((x) => ({ id: x.id, ...x.data() }))
        .filter((e) => e.tipo === "teor" && e.resultado?.teor != null)
        .sort((a, b) => (a.dataRef + (a.criadoEm || "")).localeCompare(b.dataRef + (b.criadoEm || "")));
      const gcs = fs.docs.map((x) => x.data())
        .flatMap((f) => (f.ensaios || []).filter((r) => num(r.gc) != null).map((r) => ({ dataRef: f.dataRef, gc: num(r.gc), estaca: r.estaca })))
        .sort((a, b) => a.dataRef.localeCompare(b.dataRef));
      setD({ teores, gcs });
    })();
  }, [obra.id]);

  if (!d) return null;
  const tp = d.teores[0]?.resultado?.tp, tol = d.teores[0]?.resultado?.tol ?? 0.3;
  const est = (arr) => {
    if (!arr.length) return null;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const s = arr.length > 1 ? Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1)) : 0;
    return { m, s, n: arr.length };
  };
  const eT = est(d.teores.map((e) => e.resultado.teor));
  const eG = est(d.gcs.map((g) => g.gc));
  const dentroT = tp != null ? d.teores.filter((e) => Math.abs(e.resultado.teor - tp) <= tol).length : null;
  const dentroG = d.gcs.filter((g) => g.gc >= LIMITES.gcMin).length;

  return (
    <Impressao fechar={fechar} link={linkRel("carta", obra?.id)} estatico={estatico}>
      <CabecalhoRel titulo="CARTA DE CONTROLE ESTATÍSTICO" numero={`CC-${(obra.nome || "OB").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase()}`} obra={obra} dataRef={hojeISO()} />

      <div style={secRel}>1 · Teor de ligante — tendência do processo</div>
      <ChartControle
        titulo={tp != null ? `Teor medido vs. projeto ${tp}% ± ${tol}%` : "Teor medido (sem projeto vinculado)"}
        pontos={d.teores.map((e) => ({ y: e.resultado.teor, rot: `${e.dataRef.slice(8, 10)}/${e.dataRef.slice(5, 7)}`, fora: tp != null && Math.abs(e.resultado.teor - tp) > tol }))}
        refs={tp != null ? [
          { v: tp, cor: C.navy, rot: `Projeto ${tp}%` },
          { v: tp + tol, cor: C.red, rot: `LSC ${(tp + tol).toFixed(2)}%` },
          { v: tp - tol, cor: C.red, rot: `LIC ${(tp - tol).toFixed(2)}%` },
        ] : []} />
      {eT && <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}><tbody><tr>
        <td style={tabTd}><b>Ensaios:</b> {eT.n}</td>
        <td style={tabTd}><b>Média:</b> {eT.m.toFixed(2)}%</td>
        <td style={tabTd}><b>Desvio-padrão:</b> {eT.s.toFixed(3)}%</td>
        {dentroT != null && <td style={tabTd}><b>Dentro da tolerância:</b> {dentroT}/{eT.n} ({Math.round((dentroT / eT.n) * 100)}%)</td>}
      </tr></tbody></table>}

      <div style={secRel}>2 · Grau de compactação — pista</div>
      <ChartControle
        titulo={`GC por determinação (mínimo ${LIMITES.gcMin}% — ref. Marshall)`}
        pontos={d.gcs.map((g) => ({ y: g.gc, rot: `${g.dataRef.slice(8, 10)}/${g.dataRef.slice(5, 7)}`, fora: g.gc < LIMITES.gcMin }))}
        refs={[{ v: LIMITES.gcMin, cor: C.red, rot: `Mínimo ${LIMITES.gcMin}%` }]} />
      {eG && <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}><tbody><tr>
        <td style={tabTd}><b>Determinações:</b> {eG.n}</td>
        <td style={tabTd}><b>Média:</b> {eG.m.toFixed(1)}%</td>
        <td style={tabTd}><b>Desvio-padrão:</b> {eG.s.toFixed(2)}%</td>
        <td style={tabTd}><b>≥ {LIMITES.gcMin}%:</b> {dentroG}/{eG.n} ({Math.round((dentroG / eG.n) * 100)}%)</td>
      </tr></tbody></table>}

      <div style={{ fontSize: 10, color: C.mut, marginTop: 14, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Pontos verdes: dentro do limite · pontos vermelhos: fora do limite. Valores medidos e registrados em campo pelo sistema Solocontrol; limites conforme projeto e especificação contratual cadastrados. Documento gerado em {fmtDataHora()}.
      </div>
    </Impressao>
  );
}

// ============================================================================
// Imprimação (bandeja DNIT 144/2014) — cálculo + Formulários de campo (impressão)
// ============================================================================
function calcImprim(r, cfg) {
  const p1 = num(r.p1), p2 = num(r.p2), area = num(cfg?.area) || 0.09;
  if (p1 == null || p2 == null || p2 <= p1 || area <= 0) return null;
  const dif = Math.round((p2 - p1) * 1000) / 1000;
  const taxa = dif / area; // kg/m² ≈ l/m²
  const alvo = num(cfg?.alvo) ?? 0.8, tol = num(cfg?.tol) ?? 0.2;
  return { dif, taxa, alvo, tol, sit: Math.abs(taxa - alvo) <= tol ? "conforme" : "nao_conforme" };
}

function FormulariosCampo({ obra, dataRef, fechar, estatico }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    (async () => {
      const [cs, fe] = await Promise.all([
        getDocs(query(collection(db, "cargas"), where("obraId", "==", obra.id), where("dataRef", "==", dataRef))),
        getDoc(doc(db, "fechamentos", `${obra.id}_${dataRef}`)),
      ]);
      const cargas = cs.docs.map((x) => ({ id: x.id, ...x.data() }));
      cargas.sort((a, b) => (a.horaSaida || "").localeCompare(b.horaSaida || ""));
      setD({ cargas, fech: fe.exists() ? fe.data() : null });
    })();
  }, [obra.id, dataRef]);
  if (!d) return null;
  const { cargas, fech } = d;
  const ton = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const cfg = fech?.imprimCfg || { alvo: "0,8", tol: "0,2", area: "0,09" };
  const medidas = (fech?.imprimacao || []).map((r) => ({ r, c: calcImprim(r, cfg) })).filter((x) => x.c);
  const tecnicos = [...new Set(cargas.map((c) => c.descarga?.registradoPor || c.chegada?.registradoPor).filter(Boolean))];
  const celT = { ...tabTd, fontSize: 11.5 };
  return (
    <Impressao fechar={fechar} link={linkRel("campo", obra?.id, dataRef)} estatico={estatico}>
      <CabecalhoRel titulo="CONTROLE DE CAMPO" numero={`CB-${dataRef.replace(/-/g, "")}-${(obra?.nome || "OB").replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase()}`} obra={obra} dataRef={dataRef} />

      <div style={secRel}>Controle de CBUQ — aplicação na pista</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Data", "Nº NF", "Placa", "Local de aplicação (pista)", "Quant. NF (t)", "Início", "Fim", "Temp. (°C)"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
        <tbody>
          {cargas.map((c) => (
            <tr key={c.id}>
              <td style={celT}>{fmtBR(dataRef)}</td>
              <td style={celT}>{c.nf || "—"}</td>
              <td style={celT}><b>{c.placa}</b></td>
              <td style={celT}>{c.descarga?.trecho || "—"}</td>
              <td style={celT}>{c.tonelagem}</td>
              <td style={celT}>{c.descarga?.inicio || "—"}</td>
              <td style={celT}>{c.descarga?.fim || "—"}</td>
              <td style={{ ...celT, fontWeight: 800, color: c.descarga?.tempAplicacao != null && c.descarga.tempAplicacao < LIMITES.tempAplicMin ? C.red : C.ink }}>{c.descarga?.tempAplicacao ?? "—"}</td>
            </tr>
          ))}
          <tr><td style={celT} colSpan={4}><b>TOTAL</b></td><td style={{ ...celT, fontWeight: 800 }}>{ton.toFixed(2)}</td><td style={celT} colSpan={3}>{cargas.length} carga(s)</td></tr>
        </tbody>
      </table>

      {medidas.length > 0 && (
        <>
          <div style={secRel}>Imprimação com ligante asfáltico — DNIT 144/2014 (ensaio da bandeja)</div>
          <div style={{ fontSize: 11, color: C.mut, marginBottom: 6 }}>Taxa de projeto: {cfg.alvo} l/m² · tolerância ± {cfg.tol} · área da bandeja: {cfg.area} m²</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Data", "Trecho aplicado", "Peso 01 (kg)", "Peso 02 (kg)", "Diferença (kg)", "Taxa (l/m²)", "Situação"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
            <tbody>{medidas.map(({ r, c }, i) => (
              <tr key={i}>
                <td style={celT}>{fmtBR(dataRef)}</td>
                <td style={celT}>{r.trecho || "—"}</td>
                <td style={celT}>{r.p1}</td>
                <td style={celT}>{r.p2}</td>
                <td style={celT}>{c.dif.toFixed(3)}</td>
                <td style={{ ...celT, fontWeight: 800 }}>{c.taxa.toFixed(2)}</td>
                <td style={{ ...celT, fontWeight: 800, color: c.sit === "conforme" ? C.ok : C.red }}>{c.sit === "conforme" ? "CONFORME" : "NÃO CONFORME"}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}

      <FotosRel titulo="Registro fotográfico — imprimação (bandeja)" fotos={fech?.fotosImprimacao} />
      {fech?.obs && <><div style={secRel}>Observações</div><div style={{ fontSize: 11.5 }}>{fech.obs}</div></>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 30, marginTop: 44, breakInside: "avoid" }}>
        {[`Técnico de obra${tecnicos.length ? ` — ${tecnicos.join(" / ")}` : ""}`, "Fiscalização / contratante"].map((r) => (
          <div key={r} style={{ textAlign: "center" }}><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 5, fontSize: 10.5 }}>{r}</div></div>
        ))}
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Registros lançados em campo em tempo real pelo sistema Solocontrol, com autoria e horário auditáveis. Documento gerado em {fmtDataHora()}.
      </div>
    </Impressao>
  );
}

// ============================================================================
// Abertura de relatório por link (usado na exportação em PDF pelo navegador)
// ============================================================================
function RelatorioPorLink({ tipo, obraId, data }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const os = await getDoc(doc(db, "obras", obraId));
        if (!os.exists()) return setD({ erro: "Obra não encontrada." });
        const obra = { id: os.id, ...os.data() };
        if (tipo === "carta") return setD({ obra });
        if (tipo === "campo") return setD({ obra });
        if (tipo === "resumo" || tipo === "aplicacao") {
          const [cs, fs] = await Promise.all([
            getDocs(query(collection(db, "cargas"), where("obraId", "==", obraId))),
            getDocs(query(collection(db, "fechamentos"), where("obraId", "==", obraId))),
          ]);
          return setD({ obra, cargas: cs.docs.map((x) => ({ id: x.id, ...x.data() })), fechs: fs.docs.map((x) => ({ id: x.id, ...x.data() })) });
        }
        const [cs, fe, es, ps, an] = await Promise.all([
          getDocs(query(collection(db, "cargas"), where("obraId", "==", obraId), where("dataRef", "==", data))),
          getDoc(doc(db, "fechamentos", `${obraId}_${data}`)),
          getDocs(query(collection(db, "ensaios"), where("obraId", "==", obraId), where("dataRef", "==", data))),
          getDocs(collection(db, "projetos")),
          getDoc(doc(db, "analises", `${obraId}_${data}`)),
        ]);
        const cargas = cs.docs.map((x) => ({ id: x.id, ...x.data() }));
        cargas.sort((a, b) => (a.horaSaida || "").localeCompare(b.horaSaida || ""));
        const ensaios = es.docs.map((x) => ({ id: x.id, ...x.data() }));
        ensaios.sort((a, b) => (a.criadoEm || "").localeCompare(b.criadoEm || ""));
        const projetos = ps.docs.map((x) => ({ id: x.id, ...x.data() })).filter((p) => !p.obraId || p.obraId === obraId);
        setD({
          obra, cargas, ensaios,
          fech: fe.exists() ? fe.data() : null,
          projeto: projetos.find((p) => p.status === "Aprovado") || projetos[0] || null,
          analise: an.exists() ? an.data() : null,
        });
      } catch { setD({ erro: "Não foi possível carregar o relatório." }); }
    })();
  }, [tipo, obraId, data]);

  if (!d) return <Aviso txt="Carregando relatório…" />;
  if (d.erro) return <Aviso txt={d.erro} />;
  const voltar = () => { window.location.href = location.origin; };
  if (tipo === "carta") return <CartaControle obra={d.obra} fechar={voltar} estatico />;
  if (tipo === "campo") return <FormulariosCampo obra={d.obra} dataRef={data} fechar={voltar} estatico />;
  if (tipo === "aplicacao") return <RelatorioAplicacao obra={d.obra} cargas={d.cargas} fechs={d.fechs} fechar={voltar} estatico />;
  if (tipo === "resumo") return <ResumoObra obra={d.obra} cargas={d.cargas} fechs={d.fechs} fechar={voltar} estatico />;
  if (tipo === "usina") return <RelatorioUsina obra={d.obra} dataRef={data} cargas={d.cargas} ensaios={d.ensaios} projeto={d.projeto} analise={d.analise} fechar={voltar} estatico />;
  return <RelatorioDiario obra={d.obra} dataRef={data} cargas={d.cargas} fech={d.fech} fechar={voltar} estatico />;
}

// ============================================================================
// RELATÓRIO TÉCNICO DE APLICAÇÃO (obra/pista) — consolidado por trecho
// ============================================================================
const mediaDe = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const desvioDe = (a) => {
  if (a.length < 2) return null;
  const m = mediaDe(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

function consolidarAplicacao(obra, cargas, fechs) {
  const aplicadas = cargas.filter((c) => c.descarga?.fim);
  const dias = [...new Set(cargas.map((c) => c.dataRef))].sort();
  const ton = aplicadas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const tApl = aplicadas.map((c) => c.descarga?.tempAplicacao).filter((v) => v != null);
  const perdas = cargas.map((c) => c.transporte?.perda).filter((v) => v != null);
  const transp = cargas.map((c) => c.transporte?.minutos).filter((v) => v != null);
  const descarga = aplicadas.map((c) => minutosEntre(c.descarga?.inicio, c.descarga?.fim)).filter((v) => v != null);
  const espera = cargas.map((c) => minutosEntre(c.chegada?.hora, c.descarga?.inicio)).filter((v) => v != null && v >= 0);
  const gcs = fechs.flatMap((f) => (f.ensaios || []).map((r) => num(r.gc)).filter((v) => v != null));
  const espCamp = fechs.flatMap((f) => (f.ensaios || []).map((r) => num(r.esp)).filter((v) => v != null));
  const espSolta = aplicadas.map((c) => num(c.descarga?.espessura)).filter((v) => v != null);
  const imprim = fechs.flatMap((f) => (f.imprimacao || []).map((r) => calcImprim(r, f.imprimCfg)).filter(Boolean));
  const frias = aplicadas.filter((c) => c.descarga?.tempAplicacao != null && c.descarga.tempAplicacao < LIMITES.tempAplicMin);
  const gcBaixo = gcs.filter((v) => v < LIMITES.gcMin);

  // Agrupamento por trecho aplicado
  const trechos = {};
  aplicadas.forEach((c) => {
    const k = (c.descarga?.trecho || "Não informado").trim();
    (trechos[k] ||= { nome: k, cargas: 0, ton: 0, temps: [], esp: [], dias: new Set() });
    trechos[k].cargas++;
    trechos[k].ton += c.tonelagem || 0;
    if (c.descarga?.tempAplicacao != null) trechos[k].temps.push(c.descarga.tempAplicacao);
    const e = num(c.descarga?.espessura); if (e != null) trechos[k].esp.push(e);
    trechos[k].dias.add(c.dataRef);
  });

  // Ensaios de pista detalhados (para apontar a estaca crítica)
  const gcDetalhe = fechs.flatMap((f) => (f.ensaios || [])
    .filter((r) => num(r.gc) != null)
    .map((r) => ({ dataRef: f.dataRef, gc: num(r.gc), estaca: r.estaca || "—", esp: num(r.esp) })));

  const amostras = fechs.flatMap((f) => (f.amostras || [])
    .filter((a) => a.ident || a.placa)
    .map((a) => ({ ...a, dataRef: f.dataRef })));

  // Registro fotográfico separado por etapa
  const fotos = {
    usina: cargas.flatMap((c) => (c.fotosUsina || []).map((f) => ({ ...f, legenda: `${c.placa} · carregamento na usina · ${fmtBR(c.dataRef)}` }))),
    chegada: cargas.flatMap((c) => (c.chegada?.fotos || []).map((f) => ({ ...f, legenda: `${c.placa} · chegada ${c.chegada?.hora || ""} · ${c.chegada?.temp ?? "—"} °C · ${fmtBR(c.dataRef)}` }))),
    aplicacao: cargas.flatMap((c) => (c.descarga?.fotos || []).map((f) => ({ ...f, legenda: `${c.placa} · ${c.descarga?.trecho || "trecho —"} · ${c.descarga?.tempAplicacao ?? "—"} °C · ${fmtBR(c.dataRef)}` }))),
    pista: fechs.flatMap((f) => (f.fotos || []).map((x) => ({ ...x, legenda: `${x.legenda || "Pista"} · ${fmtBR(f.dataRef)}` }))),
    imprimacao: fechs.flatMap((f) => (f.fotosImprimacao || []).map((x) => ({ ...x, legenda: `Imprimação · ${fmtBR(f.dataRef)}` }))),
  };
  const totalFotos = Object.values(fotos).reduce((s, a) => s + a.filter((f) => f.url).length, 0);

  // Estatística por dia de aplicação
  const porDia = dias.map((dia) => {
    const cs = aplicadas.filter((c) => c.dataRef === dia);
    const t = cs.reduce((s, c) => s + (c.tonelagem || 0), 0);
    const temps = cs.map((c) => c.descarga?.tempAplicacao).filter((v) => v != null);
    const g = fechs.filter((f) => f.dataRef === dia).flatMap((f) => (f.ensaios || []).map((r) => num(r.gc)).filter((v) => v != null));
    return { dia, cargas: cs.length, ton: t, tempMedia: mediaDe(temps), gcMedio: mediaDe(g),
      ncs: cs.filter((c) => c.status === "nao_conforme").length, fechadoPor: fechs.find((f) => f.dataRef === dia)?.fechadoPor || "—" };
  });

  return {
    dias, aplicadas, ton, tApl, perdas, transp, descarga, espera, gcs, espCamp, espSolta, imprim, frias, gcBaixo,
    gcDetalhe, amostras, fotos, totalFotos, porDia,
    trechos: Object.values(trechos).sort((a, b) => b.ton - a.ton),
    tonDia: dias.length ? ton / dias.length : null,
  };
}

function gerarAnaliseAplicacao(obra, d) {
  const p = [];
  const espProj = num(obra?.espessuraProjeto);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

  // 1 · Produção e ritmo de execução
  const melhorDia = [...d.porDia].sort((a, b) => b.ton - a.ton)[0];
  p.push(`1. PRODUÇÃO E RITMO — Foram aplicadas ${d.ton.toFixed(1)} t de concreto asfáltico em ${d.aplicadas.length} carga(s) ao longo de ${d.dias.length} dia(s) de execução${d.dias.length ? ` (${fmtBR(d.dias[0])} a ${fmtBR(d.dias[d.dias.length - 1])})` : ""}. A média foi de ${d.tonDia ? d.tonDia.toFixed(1) : "—"} t e ${d.dias.length ? (d.aplicadas.length / d.dias.length).toFixed(1) : "—"} carga(s) por dia de aplicação${melhorDia ? `, com maior volume em ${fmtBR(melhorDia.dia)} (${melhorDia.ton.toFixed(1)} t em ${melhorDia.cargas} carga(s))` : ""}.`);

  // 2 · Controle térmico
  if (d.tApl.length) {
    const m = mediaDe(d.tApl), sd = desvioDe(d.tApl);
    p.push(`2. CONTROLE TÉRMICO NA APLICAÇÃO — Temperaturas registradas entre ${Math.min(...d.tApl)} °C e ${Math.max(...d.tApl)} °C, média de ${m.toFixed(1)} °C${sd != null ? ` e desvio-padrão de ${sd.toFixed(1)} °C` : ""}, para o critério mínimo de ${LIMITES.tempAplicMin} °C adotado. ${d.frias.length ? `Registraram-se ${d.frias.length} carga(s) abaixo do mínimo (${pct(d.frias.length, d.aplicadas.length)}% do total): ${d.frias.map((c) => `${c.placa} — ${c.descarga.tempAplicacao} °C em ${c.descarga.trecho || "trecho não informado"} (${fmtBR(c.dataRef)})`).join("; ")}.` : `Todas as ${d.aplicadas.length} carga(s) aplicadas atenderam ao mínimo, com margem de ${(Math.min(...d.tApl) - LIMITES.tempAplicMin).toFixed(1)} °C no ponto mais crítico.`}`);
  } else p.push("2. CONTROLE TÉRMICO NA APLICAÇÃO — Não há temperaturas de aplicação registradas no período.");

  // 3 · Ciclo logístico e perda térmica (com taxa medida)
  if (d.perdas.length || d.transp.length) {
    const acima = d.perdas.filter((v) => v > LIMITES.perdaAlerta).length;
    const perdaMed = mediaDe(d.perdas), transpMed = mediaDe(d.transp);
    const taxa = perdaMed != null && transpMed ? (perdaMed / transpMed) * 10 : null;
    const cicloMed = [transpMed, mediaDe(d.espera), mediaDe(d.descarga)].filter((v) => v != null).reduce((a, b) => a + b, 0);
    p.push(`3. CICLO LOGÍSTICO E PERDA TÉRMICA — Tempo médio de transporte usina→obra de ${fmtMin(Math.round(transpMed || 0))}${d.espera.length ? `, espera média de ${fmtMin(Math.round(mediaDe(d.espera)))} até o início da descarga` : ""}${d.descarga.length ? ` e ${fmtMin(Math.round(mediaDe(d.descarga)))} de descarga` : ""}, totalizando um ciclo médio de ${fmtMin(Math.round(cicloMed))} por caminhão na obra. ${perdaMed != null ? `A perda térmica média entre a saída da usina e a chegada foi de ${perdaMed.toFixed(1)} °C (máxima de ${Math.max(...d.perdas)} °C)${taxa != null ? `, equivalente a aproximadamente ${taxa.toFixed(1)} °C a cada 10 minutos de transporte nas condições registradas` : ""}. ${acima ? `Foram identificadas ${acima} ocorrência(s) acima do parâmetro de alerta de ${LIMITES.perdaAlerta} °C.` : `Nenhuma ocorrência ultrapassou o parâmetro de alerta de ${LIMITES.perdaAlerta} °C.`}` : ""}${d.espera.length && mediaDe(d.espera) > 20 ? ` Observa-se que a espera média para descarga (${fmtMin(Math.round(mediaDe(d.espera)))}) é o componente mais relevante do ciclo — dado registrado para avaliação da equipe de produção.` : ""}`);
  }

  // 4 · Compactação
  if (d.gcs.length) {
    const m = mediaDe(d.gcs), sd = desvioDe(d.gcs);
    const cv = sd != null && m ? (sd / m) * 100 : null;
    const pior = [...d.gcDetalhe].sort((a, b) => a.gc - b.gc)[0];
    p.push(`4. COMPACTAÇÃO — Executadas ${d.gcs.length} determinação(ões) de grau de compactação, com média de ${m.toFixed(1)}%, mínimo de ${Math.min(...d.gcs).toFixed(1)}% (${pior ? `${pior.estaca}, ${fmtBR(pior.dataRef)}` : "—"}) e máximo de ${Math.max(...d.gcs).toFixed(1)}%${sd != null ? `, desvio-padrão de ${sd.toFixed(2)}%${cv != null ? ` e coeficiente de variação de ${cv.toFixed(2)}%` : ""}` : ""}, para o critério mínimo de ${LIMITES.gcMin}%. ${d.gcBaixo.length ? `${d.gcBaixo.length} determinação(ões) (${pct(d.gcBaixo.length, d.gcs.length)}%) ficaram abaixo do mínimo e constam no quadro de não conformidades.` : `Todas as determinações atenderam ao critério (${d.gcs.length}/${d.gcs.length}), com margem de ${(Math.min(...d.gcs) - LIMITES.gcMin).toFixed(1)} ponto(s) percentual(is) no ponto mais crítico.`}`);
  } else p.push("4. COMPACTAÇÃO — Não há determinações de grau de compactação registradas no período.");

  // 5 · Espessura
  if (d.espCamp.length || d.espSolta.length) {
    const partes = [];
    if (d.espCamp.length) {
      const m = mediaDe(d.espCamp), sd = desvioDe(d.espCamp);
      const desvioProj = espProj != null ? ((m - espProj) / espProj) * 100 : null;
      partes.push(`espessura medida em ${d.espCamp.length} ponto(s) com média de ${m.toFixed(2)} cm (mín. ${Math.min(...d.espCamp)} cm, máx. ${Math.max(...d.espCamp)} cm${sd != null ? `, desvio-padrão ${sd.toFixed(2)} cm` : ""})${desvioProj != null ? `, o que representa ${desvioProj > 0 ? "+" : ""}${desvioProj.toFixed(1)}% em relação à espessura de projeto de ${espProj} cm` : ""}`);
    }
    if (d.espSolta.length) partes.push(`espessura solta conferida no gabarito com média de ${mediaDe(d.espSolta).toFixed(2)} cm em ${d.espSolta.length} verificação(ões)`);
    p.push(`5. ESPESSURA DA CAMADA — ${partes.join("; ")}.`);
  }

  // 6 · Imprimação
  if (d.imprim.length) {
    const taxas = d.imprim.map((x) => x.taxa);
    const nc = d.imprim.filter((x) => x.sit !== "conforme").length;
    p.push(`6. IMPRIMAÇÃO / PINTURA DE LIGAÇÃO — ${d.imprim.length} determinação(ões) pelo método da bandeja (DNIT 144/2014), taxa média de ${mediaDe(taxas).toFixed(2)} l/m² (mín. ${Math.min(...taxas).toFixed(2)}, máx. ${Math.max(...taxas).toFixed(2)}) para taxa de projeto de ${d.imprim[0].alvo} ± ${d.imprim[0].tol} l/m². ${nc ? `${nc} determinação(ões) fora da tolerância.` : "Todas as determinações dentro da tolerância cadastrada."}`);
  }

  // 7 · Desempenho por trecho
  if (d.trechos.length) {
    const comTemp = d.trechos.filter((t) => t.temps.length);
    const maisFrio = comTemp.length ? [...comTemp].sort((a, b) => mediaDe(a.temps) - mediaDe(b.temps))[0] : null;
    p.push(`7. DESEMPENHO POR TRECHO — A execução distribuiu-se em ${d.trechos.length} trecho(s): ${d.trechos.map((t) => `${t.nome} (${t.ton.toFixed(1)} t em ${t.cargas} carga(s), ${t.dias.size} dia(s)${t.temps.length ? `, temperatura média de aplicação ${mediaDe(t.temps).toFixed(1)} °C` : ""})`).join("; ")}.${maisFrio && comTemp.length > 1 ? ` O trecho com menor temperatura média de aplicação foi ${maisFrio.nome} (${mediaDe(maisFrio.temps).toFixed(1)} °C).` : ""}`);
  }

  // 8 · Rastreabilidade e evidências
  p.push(`8. RASTREABILIDADE E EVIDÊNCIAS — O período conta com ${d.totalFotos} fotografia(s) georreferenciada(s) com data, hora e identificação da obra (carregamento na usina, chegada, aplicação, ensaios de pista e imprimação), ${d.amostras.length} amostra(s) encaminhada(s) ao laboratório e ${d.dias.length} fechamento(s) diário(s) assinado(s) eletronicamente pelos técnicos responsáveis. Cada carga possui registro individual de placa, nota fiscal, tonelagem, horários e temperaturas, com autoria e horário auditáveis.`);

  // 9 · Síntese de conformidade
  const eixos = eixosAplicacao(obra, d);
  p.push(`9. SÍNTESE DE CONFORMIDADE — ${eixos.map(([nome, sit]) => `${nome}: ${sit === "pendente" ? "PENDENTE" : SIT[sit].rot.toUpperCase()}`).join(" · ")}.`);

  p.push("Os valores apresentados correspondem exclusivamente a dados medidos e registrados em campo pelo sistema, sem estimativas ou interpolações. Critério adotado conforme projeto e especificação contratual cadastrados.");
  p.push("Minuta de análise técnica de aplicação gerada automaticamente a partir dos registros. Sujeita a revisão, edição e aprovação do responsável técnico.");
  return p.join("\n\n");
}

function eixosAplicacao(obra, d) {
  const espProj = num(obra?.espessuraProjeto);
  const espOk = d.espCamp.length && espProj != null ? d.espCamp.every((v) => Math.abs(v - espProj) <= espProj * 0.1) : null;
  return [
    ["Temperatura de aplicação", d.tApl.length ? (d.frias.length ? "nao_conforme" : "conforme") : "pendente"],
    ["Perda térmica no transporte", d.perdas.length ? (d.perdas.filter((v) => v > LIMITES.perdaAlerta).length ? "atencao" : "conforme") : "pendente"],
    ["Grau de compactação", d.gcs.length ? (d.gcBaixo.length ? "nao_conforme" : "conforme") : "pendente"],
    ["Espessura da camada", d.espCamp.length ? (espOk === null ? "atencao" : espOk ? "conforme" : "atencao") : "pendente"],
    ["Imprimação / pintura de ligação", d.imprim.length ? (d.imprim.some((x) => x.sit !== "conforme") ? "nao_conforme" : "conforme") : "pendente"],
    ["Completude dos registros de pista", d.aplicadas.length && d.gcs.length ? "conforme" : "pendente"],
  ];
}

function RelatorioAplicacao({ obra, cargas, fechs, fechar, estatico }) {
  const d = useMemo(() => consolidarAplicacao(obra, cargas, fechs), [obra?.id, cargas.length, fechs.length]);
  const [texto, setTexto] = useState("");
  useEffect(() => { setTexto(gerarAnaliseAplicacao(obra, d)); }, [obra?.id, d]);
  const espProj = num(obra?.espessuraProjeto);
  const eixos = eixosAplicacao(obra, d);
  const numero = `RA-${(obra?.nome || "OB").replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase()}`;

  return (
    <Impressao fechar={fechar} link={linkRel("aplicacao", obra?.id)} estatico={estatico}>
      <CabecalhoRel titulo="RELATÓRIO TÉCNICO DE APLICAÇÃO" numero={numero} obra={obra} dataRef={obra?.dataConclusao || hojeISO()} />

      <div style={secRel}>1 · Situação por eixo (execução na pista)</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        {eixos.map(([nome, s]) => (
          <tr key={nome}><td style={tabTd}>{nome}</td>
            <td style={{ ...tabTd, textAlign: "right", fontWeight: 800, color: s !== "pendente" ? SIT[s].cor : C.mut }}>{s !== "pendente" ? SIT[s].rot.toUpperCase() : "PENDENTE"}</td></tr>
        ))}
      </tbody></table>

      <div style={secRel}>2 · Produção aplicada</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        <tr>
          <td style={tabTd}><b>Período:</b> {d.dias.length ? `${fmtBR(d.dias[0])} → ${fmtBR(d.dias[d.dias.length - 1])}` : "—"}</td>
          <td style={tabTd}><b>Dias de aplicação:</b> {d.dias.length}</td>
          <td style={tabTd}><b>Massa aplicada:</b> {d.ton.toFixed(1)} t</td>
          <td style={tabTd}><b>Cargas aplicadas:</b> {d.aplicadas.length}</td>
          <td style={tabTd}><b>Média por dia:</b> {d.tonDia ? `${d.tonDia.toFixed(1)} t` : "—"}</td>
        </tr>
        <tr>
          <td style={tabTd}><b>Temp. aplicação (mín/méd/máx):</b> {d.tApl.length ? `${Math.min(...d.tApl)} / ${mediaDe(d.tApl).toFixed(1)} / ${Math.max(...d.tApl)} °C` : "—"}</td>
          <td style={tabTd}><b>Usina → obra:</b> {d.transp.length ? fmtMin(Math.round(mediaDe(d.transp))) : "—"}</td>
          <td style={tabTd}><b>Espera p/ descarga:</b> {d.espera.length ? fmtMin(Math.round(mediaDe(d.espera))) : "—"}</td>
          <td style={tabTd}><b>Duração da descarga:</b> {d.descarga.length ? fmtMin(Math.round(mediaDe(d.descarga))) : "—"}</td>
          <td style={tabTd}><b>Perda térmica média:</b> {d.perdas.length ? `${mediaDe(d.perdas).toFixed(1)} °C` : "—"}</td>
        </tr>
      </tbody></table>

      <div style={secRel}>3 · Desempenho por trecho aplicado</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Trecho / estaca", "Cargas", "Massa (t)", "Dias", "Temp. média aplicação", "Esp. solta média (cm)"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
        <tbody>{d.trechos.map((t) => (
          <tr key={t.nome}>
            <td style={tabTd}><b>{t.nome}</b></td>
            <td style={tabTd}>{t.cargas}</td>
            <td style={tabTd}>{t.ton.toFixed(1)}</td>
            <td style={tabTd}>{t.dias.size}</td>
            <td style={{ ...tabTd, fontWeight: 700, color: t.temps.length && mediaDe(t.temps) < LIMITES.tempAplicMin ? C.red : C.ink }}>{t.temps.length ? `${mediaDe(t.temps).toFixed(1)} °C` : "—"}</td>
            <td style={tabTd}>{t.esp.length ? mediaDe(t.esp).toFixed(2) : "—"}</td>
          </tr>
        ))}</tbody>
      </table>

      <div style={secRel}>4 · Controle de compactação e espessura</div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}><tbody>
        <tr>
          <td style={tabTd}><b>Determinações de GC:</b> {d.gcs.length}</td>
          <td style={tabTd}><b>GC médio:</b> {d.gcs.length ? `${mediaDe(d.gcs).toFixed(1)}%` : "—"}</td>
          <td style={tabTd}><b>GC mínimo:</b> {d.gcs.length ? `${Math.min(...d.gcs).toFixed(1)}%` : "—"}</td>
          <td style={tabTd}><b>Desvio-padrão:</b> {desvioDe(d.gcs) != null ? `${desvioDe(d.gcs).toFixed(2)}%` : "—"}</td>
          <td style={{ ...tabTd, fontWeight: 800, color: d.gcBaixo.length ? C.red : C.ok }}><b>≥ {LIMITES.gcMin}%:</b> {d.gcs.length ? `${d.gcs.length - d.gcBaixo.length}/${d.gcs.length}` : "—"}</td>
        </tr>
        <tr>
          <td style={tabTd}><b>Espessura de projeto:</b> {espProj != null ? `${espProj} cm` : "—"}</td>
          <td style={tabTd}><b>Esp. medida (média):</b> {d.espCamp.length ? `${mediaDe(d.espCamp).toFixed(2)} cm` : "—"}</td>
          <td style={tabTd}><b>Esp. mín/máx:</b> {d.espCamp.length ? `${Math.min(...d.espCamp)} / ${Math.max(...d.espCamp)} cm` : "—"}</td>
          <td style={tabTd}><b>Esp. solta média:</b> {d.espSolta.length ? `${mediaDe(d.espSolta).toFixed(2)} cm` : "—"}</td>
          <td style={tabTd}><b>Pontos medidos:</b> {d.espCamp.length}</td>
        </tr>
      </tbody></table>
      {d.gcs.length > 0 && (
        <ChartControle titulo={`Grau de compactação por determinação (mínimo ${LIMITES.gcMin}%)`}
          pontos={fechs.flatMap((f) => (f.ensaios || []).filter((r) => num(r.gc) != null).map((r) => ({ y: num(r.gc), rot: `${f.dataRef.slice(8, 10)}/${f.dataRef.slice(5, 7)}`, fora: num(r.gc) < LIMITES.gcMin })))}
          refs={[{ v: LIMITES.gcMin, cor: C.red, rot: `Mínimo ${LIMITES.gcMin}%` }]} />
      )}

      {d.imprim.length > 0 && (
        <>
          <div style={secRel}>5 · Imprimação / pintura de ligação (bandeja)</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody><tr>
            <td style={tabTd}><b>Determinações:</b> {d.imprim.length}</td>
            <td style={tabTd}><b>Taxa média:</b> {mediaDe(d.imprim.map((x) => x.taxa)).toFixed(2)} l/m²</td>
            <td style={tabTd}><b>Taxa de projeto:</b> {d.imprim[0].alvo} ± {d.imprim[0].tol} l/m²</td>
            <td style={{ ...tabTd, fontWeight: 800, color: d.imprim.some((x) => x.sit !== "conforme") ? C.red : C.ok }}><b>Conformes:</b> {d.imprim.filter((x) => x.sit === "conforme").length}/{d.imprim.length}</td>
          </tr></tbody></table>
        </>
      )}

      <div style={secRel}>6 · Evolução diária da aplicação</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Data", "Cargas", "Massa (t)", "Temp. média aplicação", "GC médio do dia", "Não conf.", "Dia fechado por"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
        <tbody>{d.porDia.map((x) => (
          <tr key={x.dia}>
            <td style={tabTd}><b>{fmtBR(x.dia)}</b></td>
            <td style={tabTd}>{x.cargas}</td>
            <td style={tabTd}>{x.ton.toFixed(1)}</td>
            <td style={{ ...tabTd, color: x.tempMedia != null && x.tempMedia < LIMITES.tempAplicMin ? C.red : C.ink, fontWeight: 700 }}>{x.tempMedia != null ? `${x.tempMedia.toFixed(1)} °C` : "—"}</td>
            <td style={{ ...tabTd, color: x.gcMedio != null && x.gcMedio < LIMITES.gcMin ? C.red : C.ink, fontWeight: 700 }}>{x.gcMedio != null ? `${x.gcMedio.toFixed(1)}%` : "—"}</td>
            <td style={{ ...tabTd, color: x.ncs ? C.red : C.ink, fontWeight: x.ncs ? 800 : 400 }}>{x.ncs || "—"}</td>
            <td style={tabTd}>{x.fechadoPor}</td>
          </tr>
        ))}</tbody>
      </table>

      <div style={secRel}>7 · Rastreabilidade carga a carga</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Data", "Placa / NF", "Ton", "Saída", "Chegada", "Perda °C", "Transp.", "Aplic. °C", "Trecho", "Esp. (cm)", "Situação"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
        <tbody>{d.aplicadas.map((c) => (
          <tr key={c.id}>
            <td style={tabTd}>{fmtBR(c.dataRef)}</td>
            <td style={tabTd}><b>{c.placa}</b><br /><span style={{ color: C.mut }}>{c.nf || "—"}</span></td>
            <td style={tabTd}>{c.tonelagem ?? "—"}</td>
            <td style={tabTd}>{c.horaSaida}<br />{c.tempSaida}°</td>
            <td style={tabTd}>{c.chegada?.hora || "—"}<br />{c.chegada?.temp ?? "—"}°</td>
            <td style={tabTd}>{c.transporte?.perda ?? "—"}</td>
            <td style={tabTd}>{fmtMin(c.transporte?.minutos)}</td>
            <td style={{ ...tabTd, fontWeight: 700, color: c.descarga?.tempAplicacao != null && c.descarga.tempAplicacao < LIMITES.tempAplicMin ? C.red : C.ink }}>{c.descarga?.tempAplicacao ?? "—"}</td>
            <td style={tabTd}>{c.descarga?.trecho || "—"}</td>
            <td style={tabTd}>{c.descarga?.espessura || "—"}</td>
            <td style={{ ...tabTd, fontWeight: 800, color: STATUS[c.status]?.cor }}>{STATUS[c.status]?.rot}</td>
          </tr>
        ))}</tbody>
      </table>

      {d.amostras.length > 0 && (
        <>
          <div style={secRel}>8 · Amostras encaminhadas ao laboratório</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Data", "Amostra", "Placa", "NF", "Pista / trecho"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
            <tbody>{d.amostras.map((a, i) => (
              <tr key={i}><td style={tabTd}>{fmtBR(a.dataRef)}</td><td style={tabTd}><b>{a.ident || "—"}</b></td><td style={tabTd}>{a.placa || "—"}</td><td style={tabTd}>{a.nf || "—"}</td><td style={tabTd}>{a.trecho || "—"}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}

      <FotosRel titulo="Registro fotográfico — carregamento na usina" fotos={d.fotos.usina} />
      <FotosRel titulo="Registro fotográfico — chegada dos caminhões na obra" fotos={d.fotos.chegada} />
      <FotosRel titulo="Registro fotográfico — descarga e aplicação na pista" fotos={d.fotos.aplicacao} />
      <FotosRel titulo="Registro fotográfico — ensaios de pista e amostras" fotos={d.fotos.pista} />
      <FotosRel titulo="Registro fotográfico — imprimação (bandeja)" fotos={d.fotos.imprimacao} />

      {(d.frias.length > 0 || d.gcBaixo.length > 0) && (
        <>
          <div style={secRel}>Não conformidades registradas</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Tipo", "Identificação", "Valor medido", "Critério"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
            <tbody>
              {d.frias.map((c) => (
                <tr key={c.id}><td style={tabTd}>Temperatura de aplicação</td><td style={tabTd}>{c.placa} · {fmtBR(c.dataRef)} · {c.descarga?.trecho || "—"}</td>
                  <td style={{ ...tabTd, color: C.red, fontWeight: 800 }}>{c.descarga?.tempAplicacao} °C</td><td style={tabTd}>≥ {LIMITES.tempAplicMin} °C</td></tr>
              ))}
              {fechs.flatMap((f) => (f.ensaios || []).filter((r) => num(r.gc) != null && num(r.gc) < LIMITES.gcMin).map((r, i) => (
                <tr key={`${f.dataRef}-${i}`}><td style={tabTd}>Grau de compactação</td><td style={tabTd}>{r.estaca || "—"} · {fmtBR(f.dataRef)}</td>
                  <td style={{ ...tabTd, color: C.red, fontWeight: 800 }}>{r.gc}%</td><td style={tabTd}>≥ {LIMITES.gcMin}%</td></tr>
              )))}
            </tbody>
          </table>
        </>
      )}

      <div style={secRel}>Análise técnica de aplicação</div>
      <div className="nao-imprimir" style={{ marginBottom: 8 }}>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={10}
          style={{ width: "100%", boxSizing: "border-box", fontFamily: F.body, fontSize: 13.5, padding: 11, borderRadius: 11, border: `1.5px solid ${C.line}`, resize: "vertical" }} />
        <div style={{ fontSize: 12, color: C.mut, marginTop: 4 }}>Revise e edite o texto antes de exportar — ele é gerado apenas a partir dos dados registrados.</div>
      </div>
      <div style={{ fontSize: 11.5, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{texto}</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 30, marginTop: 44, breakInside: "avoid" }}>
        {["Responsável técnico — pista", "Coordenação Solocontrol"].map((r) => (
          <div key={r} style={{ textAlign: "center" }}><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 5, fontSize: 11 }}>{r}</div></div>
        ))}
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Documento gerado pelo sistema Solocontrol em {fmtDataHora()} · Nº {numero} · Consolida {cargas.length} carga(s) e {fechs.length} fechamento(s) diário(s) com registros auditáveis.
      </div>
    </Impressao>
  );
}

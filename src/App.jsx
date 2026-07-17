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
async function prepararFoto(file, obraNome) {
  const utm = await pegarGPS();
  const b64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = b64;
  });
  const MAX = 1100;
  const esc = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.round(img.width * esc), h = Math.round(img.height * esc);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const linhas = [fmtDataHora(), utm || "GPS indisponível", obraNome || "", "SOLOCONTROL 360"].filter(Boolean);
  const fs = Math.max(15, Math.round(w * 0.028));
  ctx.fillStyle = "rgba(0,0,0,.45)";
  ctx.fillRect(0, h - (linhas.length * (fs + 6) + 14), w, linhas.length * (fs + 6) + 14);
  ctx.font = `600 ${fs}px Arial`; ctx.textAlign = "right";
  linhas.forEach((l, i) => {
    ctx.fillStyle = "#fff";
    ctx.fillText(l, w - 12, h - 10 - (linhas.length - 1 - i) * (fs + 6));
  });
  return { id: rid(), b64: cv.toDataURL("image/jpeg", 0.78), utm: utm || "", hora: agoraHM() };
}

// ----------------------------------------------------------------------------
// Fila de envio para a nuvem (Storage) — NUNCA perder foto:
// se estiver sem sinal, a foto fica guardada no aparelho e o app reenvia
// sozinho quando a internet voltar.
// ----------------------------------------------------------------------------
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
  <svg width={s} height={s} viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="10" fill={C.navy} />
    <path d="M12 30 L24 14 L36 30" fill="none" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M16 36 L32 36" stroke={C.red} strokeWidth="4.5" strokeLinecap="round" />
  </svg>
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

// Miniaturas de fotos (mostra pendência de envio quando sem internet)
const Miniaturas = ({ fotos = [], locais = [], aoRemoverLocal }) => (
  (fotos.length || locais.length) ? (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      {fotos.map((f) => (
        <div key={f.id} style={{ position: "relative" }}>
          {f.url
            ? <img src={f.url} alt="" style={{ width: 74, height: 74, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.line}` }} />
            : <div style={{ width: 74, height: 74, borderRadius: 10, background: C.grayBg, display: "grid", placeItems: "center", fontSize: 11, color: C.mut, textAlign: "center", border: `1px dashed ${C.line}` }}>⏳ enviando<br />p/ nuvem</div>}
        </div>
      ))}
      {locais.map((f, i) => (
        <div key={f.id} style={{ position: "relative" }}>
          <img src={f.b64} alt="" style={{ width: 74, height: 74, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.line}` }} />
          {aoRemoverLocal && <button onClick={() => aoRemoverLocal(i)} style={{ position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 99, border: "none", background: C.red, color: "#fff", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>×</button>}
        </div>
      ))}
    </div>
  ) : null
);

// Botão de câmera: docPath definido → envia direto pra nuvem;
// sem docPath → guarda localmente até o registro ser salvo (modo diferido).
function BotaoFoto({ obraNome, docPath, campo, legenda, aoLocal, rotulo = "📷 Adicionar foto" }) {
  const ref = useRef(null);
  const [ocupado, setOcupado] = useState(false);
  return (
    <>
      <input ref={ref} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={async (e) => {
          const file = e.target.files?.[0]; e.target.value = "";
          if (!file) return;
          setOcupado(true);
          try {
            const foto = await prepararFoto(file, obraNome);
            if (docPath) await anexarFoto(docPath, campo, foto, legenda || "");
            else aoLocal && aoLocal(foto);
          } finally { setOcupado(false); }
        }} />
      <Btn tom="claro" onClick={() => ref.current?.click()} disabled={ocupado} style={{ padding: "11px 14px" }}>
        {ocupado ? "Processando…" : rotulo}
      </Btn>
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
          <Logo s={64} />
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 30, color: "#fff", letterSpacing: 1, marginTop: 10 }}>SOLOCONTROL <span style={{ color: "#FF6B6B" }}>360</span></div>
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
        <div style={{ textAlign: "center", color: "#8E9AC6", fontSize: 11.5, marginTop: 14 }}>Qualidade que constrói confiança</div>
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
            <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 17, letterSpacing: 0.6 }}>SOLOCONTROL <span style={{ color: "#FF6B6B" }}>360</span></div>
            <div style={{ fontSize: 11, color: "#AEB8E0" }}>{perfil.nome} · {perfil.papel === "coordenador" ? "Coordenação" : perfil.papel === "usina" ? "Técnico de usina" : "Técnico de obra"}</div>
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
            background: "none", border: "none", cursor: "pointer", padding: "4px 10px",
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
  const [fotos, setFotos] = useState([]);
  const [msg, setMsg] = useState("");
  const [salvando, setSalvando] = useState(false);
  const m = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  // Rascunho automático no aparelho (não perde nem fechando o app)
  useEffect(() => { try { localStorage.setItem(RASCUNHO, JSON.stringify(f)); } catch {} }, [f]);

  const obra = obras.find((o) => o.id === f.obraId);
  const t = num(f.tempSaida);
  const tempFora = t != null && (t < LIMITES.tempSaidaMin || t > LIMITES.tempSaidaMax);

  const salvar = async () => {
    setMsg("");
    if (!f.obraId) return setMsg("Selecione a obra de destino.");
    if (!f.usina?.trim()) return setMsg("Informe a usina de origem.");
    if (!f.placa?.trim() || t == null || !num(f.tonelagem)) return setMsg("Preencha placa, tonelagem e temperatura.");
    setSalvando(true);
    try {
      const dados = {
        dataRef: hojeISO(), obraId: f.obraId, obraNome: obra?.nome || "",
        usina: f.usina.trim(), placa: f.placa.trim().toUpperCase(), nf: (f.nf || "").trim(),
        tonelagem: num(f.tonelagem), tempSaida: t, horaSaida: f.horaSaida || agoraHM(),
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
          <Campo rotulo="Nota fiscal" value={f.nf || ""} onChange={m("nf")} placeholder="8504" inputMode="numeric" />
          <Campo rotulo="Tonelagem *" sufixo="t" value={f.tonelagem || ""} onChange={m("tonelagem")} placeholder="0,0" inputMode="decimal" />
          <Campo rotulo="Temp. de saída *" sufixo="°C" value={f.tempSaida || ""} onChange={m("tempSaida")} placeholder="160" inputMode="decimal" />
          <Campo rotulo="Hora de saída" type="time" value={f.horaSaida || agoraHM()} onChange={m("horaSaida")} />
        </div>
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
            <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 18, color: C.navy }}>{c.placa} · {c.tonelagem} t</div>
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
        : aba === "boletins" ? <ObraBoletins perfil={perfil} obra={obra} /> : <ObraFechamento perfil={perfil} obra={obra} />}
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
  const [de, setDe] = useState({ tempAplicacao: "", trecho: "", espessura: "", clima: "", obs: "" });
  const [editar, setEditar] = useState(false);
  useEffect(() => { if (c.chegada) setCh({ hora: c.chegada.hora || agoraHM(), temp: c.chegada.temp ?? "" }); }, [c.chegada?.hora]);
  useEffect(() => { if (c.descarga) setDe((v) => ({ ...v, ...c.descarga })); }, [c.descarga?.inicio]);

  // Salvamento automático campo a campo direto na nuvem
  const salvarCampo = (caminho, v) => updateDoc(doc(db, dp), { [caminho]: v, ultimaEdicao: edicao(perfil) }).catch(() => {});

  const confirmarChegada = () => {
    const t = num(ch.temp);
    if (t == null) return alert("Informe a temperatura de chegada.");
    const minutos = minutosEntre(c.horaSaida, ch.hora);
    const perda = c.tempSaida != null ? Math.round((c.tempSaida - t) * 10) / 10 : null;
    updateDoc(doc(db, dp), {
      "chegada.hora": ch.hora, "chegada.temp": t,
      "chegada.registradoPor": perfil.nome,
      transporte: { minutos, perda }, status: "no_local", ultimaEdicao: edicao(perfil),
    }).catch(() => {});
  };
  const iniciarDescarga = () => updateDoc(doc(db, dp), { "descarga.inicio": agoraHM(), status: "descarregando", ultimaEdicao: edicao(perfil) }).catch(() => {});
  const finalizar = () => {
    const t = num(de.tempAplicacao);
    if (t == null) return alert("Informe a temperatura na aplicação.");
    if (!de.trecho?.trim()) return alert("Informe o trecho/estaca.");
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
      <Linha k="Saída" v={`${c.horaSaida} · ${c.tempSaida} °C · ${c.tonelagem} t`} />
      {c.transporte && <Linha k="Transporte" v={`${fmtMin(c.transporte.minutos)} · perda térmica ${c.transporte.perda ?? "—"} °C`} forte />}
      {perdaAlta && <div style={{ background: C.warnBg, color: C.amber, fontSize: 13, fontWeight: 600, borderRadius: 10, padding: "8px 12px", margin: "8px 0" }}>⚠️ Perda térmica acima de {LIMITES.perdaAlerta} °C no transporte.</div>}

      {c.status === "em_transito" && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
          <div style={{ fontWeight: 800, color: C.ink, fontSize: 14.5, marginBottom: 8 }}>📍 Registrar chegada na obra</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Campo rotulo="Hora da chegada" type="time" value={ch.hora} onChange={(e) => setCh({ ...ch, hora: e.target.value })} />
            <Campo rotulo="Temp. de chegada" sufixo="°C" inputMode="decimal" value={ch.temp} onChange={(e) => setCh({ ...ch, temp: e.target.value })} />
          </div>
          <BotaoFoto obraNome={c.obraNome} docPath={dp} campo="chegada.fotos" legenda="Chegada na obra" rotulo="📷 Foto da carga chegando" />
          <Miniaturas fotos={c.chegada?.fotos} />
          <div style={{ height: 10 }} />
          <Btn tom="ok" onClick={confirmarChegada}>✔ Confirmar chegada</Btn>
        </div>
      )}

      {c.status === "no_local" && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
          <Linha k="Chegada" v={`${c.chegada?.hora} · ${c.chegada?.temp} °C`} />
          <Miniaturas fotos={c.chegada?.fotos} />
          <div style={{ height: 10 }} />
          <Btn onClick={iniciarDescarga}>▶ Iniciar descarga</Btn>
        </div>
      )}

      {(c.status === "descarregando" || (encerrada && editar)) && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
          <div style={{ fontWeight: 800, color: C.ink, fontSize: 14.5, marginBottom: 8 }}>⬇️ Descarga e aplicação {c.descarga?.inicio ? `· início ${c.descarga.inicio}` : ""}</div>
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
  const pronto = useRef(false);

  // Carrega (ou cria) o fechamento do dia e escuta as fotos em tempo real
  useEffect(() => {
    pronto.current = false;
    const dref = doc(db, "fechamentos", fid);
    setDoc(dref, { obraId: obra.id, obraNome: obra.nome, dataRef, criadoEm: agoraISO() }, { merge: true }).catch(() => {});
    const un = onSnapshot(dref, (s) => {
      const d = s.data() || {};
      setFotosNuvem(d.fotos || []);
      if (!pronto.current) {
        setF({
          retorno: d.retorno || "", caminhoesRetorno: d.caminhoesRetorno || "",
          ensaios: d.ensaios?.length ? d.ensaios : [{ estaca: "", gc: "", esp: "", dens: "" }],
          amostras: d.amostras?.length ? d.amostras : [{ ident: "", placa: "", nf: "", trecho: "" }],
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
        ensaios: f.ensaios, amostras: f.amostras, obs: f.obs,
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
        <div style={{ fontWeight: 800, fontSize: 15.5, color: C.navy, marginBottom: 10 }}>📷 Fotos do dia (pista, ensaios, amostras)</div>
        <BotaoFoto obraNome={obra.nome} docPath={dp} campo="fotos" legenda="Fechamento do dia" />
        <Miniaturas fotos={fotosNuvem} />
      </Cartao>

      <Cartao>
        <Campo rotulo="Observações gerais do dia" value={f.obs} onChange={(e) => setF({ ...f, obs: e.target.value })} placeholder="Paralisações, clima, intercorrências…" />
        <Btn tom="red" onClick={fechar} disabled={f.fechado}>{f.fechado ? "Dia já fechado" : "🔒 Fechar o dia e enviar à coordenação"}</Btn>
      </Cartao>
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

  return (
    <>
      <Titulo sub={`Panorama de hoje · ${fmtBR(hojeISO())} · atualiza em tempo real`}>Painel geral</Titulo>
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
          {transito.map((c) => <Linha key={c.id} k={`${c.placa} → ${c.obraNome}`} v={`saiu ${c.horaSaida} · ${c.tempSaida} °C · ${c.tonelagem} t`} />)}
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
            {o.status === "ativa"
              ? <Btn tom="red" cheio={false} onClick={() => concluir(o)} style={{ flex: 1, padding: "10px" }}>🏁 Concluir obra</Btn>
              : <Btn tom="claro" cheio={false} onClick={() => updateDoc(doc(db, "obras", o.id), { status: "ativa", dataConclusao: "" })} style={{ flex: 1, padding: "10px" }}>Reativar</Btn>}
          </div>
        </Cartao>
      ))}
      {resumo && <ResumoObra {...resumo} fechar={() => setResumo(null)} />}
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

  const rotPapel = { coordenador: "Coordenador", usina: "Técnico de usina", obra: "Técnico de obra" };
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
              <Btn tom={u.ativo ? "red" : "ok"} cheio={false} style={{ padding: "8px 12px", fontSize: 13 }}
                onClick={() => updateDoc(doc(db, "usuarios", u.uid), { ativo: !u.ativo })}>
                {u.ativo ? "Desativar" : "Reativar"}
              </Btn>
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
        <Btn onClick={gerar}>Gerar relatório consolidado</Btn>
      </Cartao>
      {rel && <RelatorioDiario {...rel} fechar={() => setRel(null)} />}
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
  const [e, setE] = useState(existente || {
    jornada: "Diurna", metodo: METODOS_TEOR[0], projetoId: projetos.find((p) => p.status === "Aprovado")?.id || projetos[0]?.id || "",
    equipamentoId: "", amostra: "", massaInicial: "", massaAgregado: "", massaFiltro: "", obs: "",
    vinculo: { tipo: "lote" },
  });
  const proj = projetos.find((p) => p.id === e.projetoId);
  const eq = eqs.find((x) => x.id === e.equipamentoId);
  const r = calcTeor(e.massaInicial, e.massaAgregado, e.massaFiltro, proj);
  const docPath = existente?.id ? `ensaios/${existente.id}` : null;
  const [fotosLocais, setFotosLocais] = useState([]);
  const [etapa, setEtapa] = useState("Identificação da amostra");
  const ETAPAS = ["Identificação da amostra","Pesagem inicial","Equipamento Rotarex","Processo de extração","Secagem","Agregado recuperado","Pesagem final","Resultado"];

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
  const [e, setE] = useState(existente ? { ...existente, linhas: existente.dados.linhas } : {
    jornada: "Diurna", projetoId: projIni?.id || "", equipamentoId: "", amostra: "",
    massaSeca: "", fundo: "", obs: "", vinculo: { tipo: "lote" },
    linhas: (projIni?.peneiras || FAIXAS_DNIT["Faixa C"].map(([nome, li, ls]) => ({ nome, projeto: "", limInf: li, limSup: ls, tol: tolPeneira(nome) }))).map((p) => ({ ...p, massa: "" })),
  });
  const proj = projetos.find((p) => p.id === e.projetoId);
  const eq = eqs.find((x) => x.id === e.equipamentoId);
  const [fotosLocais, setFotosLocais] = useState([]);
  const [etapa, setEtapa] = useState("Identificação");
  const ETAPAS = ["Identificação","Amostra seca","Conjunto de peneiras","Peneiramento","Material retido","Pesagem","Resultado"];
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
  const [form, setForm] = useState(null); // {tipo, existente}

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
  teores.forEach((e) => p.push(`Ensaio ${e.codigo} (${e.metodo.split("—")[0].trim()}): teor de ligante medido ${e.resultado.teor.toFixed(2)}%, para projeto ${e.resultado.tp}% ± ${e.resultado.tol}% — desvio de ${e.resultado.desvio > 0 ? "+" : ""}${e.resultado.desvio}% — situação: ${SIT[e.situacao].rot.toUpperCase()}. Representatividade: ${e.vinculo?.tipo === "lote" ? "lote/jornada" : e.vinculo?.tipo === "intervalo" ? "intervalo de cargas" : "carga específica"}.`));
  const grans = ensaios.filter((e) => e.tipo === "granulometria");
  grans.forEach((e) => {
    const fora = (e.dados?.linhas || []).filter((l) => l.sit && l.sit !== "conforme");
    p.push(`Ensaio ${e.codigo} (granulometria do agregado recuperado): ${fora.length ? `peneira(s) fora do limite aplicado: ${fora.map((l) => `${l.nome} (${l.passante}%)`).join(", ")}` : "todas as peneiras dentro do limite aplicado"}; perda de massa no peneiramento de ${e.dados?.perda}% — situação geral: ${SIT[e.situacao].rot.toUpperCase()}.`);
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
        <Kpi v={ultTeor ? `${ultTeor.resultado.teor.toFixed(2)}%` : "—"} r={`Último teor (proj. ${projeto?.teorProjeto ?? "—"}%)`} cor={ultTeor ? SIT[ultTeor.situacao].cor : C.mut} />
        <Kpi v={ultGran ? `${(ultGran.dados.linhas || []).filter((l) => l.sit === "conforme").length}/${(ultGran.dados.linhas || []).filter((l) => l.sit).length}` : "—"} r="Peneiras conformes (últ.)" cor={ultGran ? SIT[ultGran.situacao].cor : C.mut} />
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
function Impressao({ children, fechar }) {
  return (
    <div className="area-impressao" style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 100, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
      <div className="nao-imprimir" style={{ position: "sticky", top: 0, display: "flex", gap: 8, padding: 10, background: C.navy, zIndex: 5 }}>
        <Btn tom="red" cheio={false} onClick={() => window.print()} style={{ flex: 1 }}>🖨️ Imprimir / salvar PDF</Btn>
        <Btn tom="claro" cheio={false} onClick={fechar} style={{ flex: 1 }}>Fechar</Btn>
      </div>
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
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 22, color: C.navy }}>SOLOCONTROL <span style={{ color: C.red }}>360</span></div>
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
            <figcaption style={{ fontSize: 8.5, padding: "3px 6px", color: C.mut }}>{f.legenda || "Registro"} · {f.hora}{f.utm ? ` · ${f.utm}` : ""}</figcaption>
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
            <tr><td style={tabTd}><b>Projeto</b></td><td style={tabTd}>{e.resultado.tp}% ± {e.resultado.tol}%</td><td style={tabTd}><b>Desvio</b></td><td style={tabTd}>{e.resultado.desvio > 0 ? "+" : ""}{e.resultado.desvio}% · <b style={{ color: SIT[e.situacao].cor }}>{SIT[e.situacao].rot.toUpperCase()}</b></td></tr>
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
function RelatorioUsina({ obra, dataRef, cargas, ensaios, projeto, analise, fechar }) {
  const ton = cargas.reduce((s, c) => s + (c.tonelagem || 0), 0);
  const temps = cargas.map((c) => c.tempSaida).filter((v) => v != null);
  const retidas = cargas.filter((c) => c.conformeSaida === false);
  const eixos = eixosConformidade({ cargas, ensaios });
  const numero = `RU-${dataRef.replace(/-/g, "")}-${(obra?.nome || "OB").replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase()}`;
  const verif = `${numero}·${cargas.length}C·${ensaios.length}E·${ton.toFixed(0)}T`;
  const historico = ensaios.flatMap((e) => (e.historico || []).map((h) => `${e.codigo} corrigido por ${h.por} em ${fmtBR(h.em?.slice(0, 10))}`));
  return (
    <Impressao fechar={fechar}>
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
        Critério adotado conforme projeto e especificação contratual cadastrados. Documento gerado pelo Solocontrol 360 em {fmtDataHora()} · Código de verificação: {verif}
      </div>
    </Impressao>
  );
}

// ----------------------------------------------------------------------------
// Relatório diário CONSOLIDADO (usina + transporte + pista + laboratório)
// ----------------------------------------------------------------------------
function RelatorioDiario({ obra, dataRef, cargas, fech, fechar }) {
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
    <Impressao fechar={fechar}>
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
      <FotosRel titulo="Registro fotográfico — pista" fotos={[...cargas.flatMap((c) => [...(c.chegada?.fotos || []), ...(c.descarga?.fotos || [])]), ...(fech?.fotos || [])]} />
      <div style={secRel}>Análise técnica</div>
      {!analise?.aprovadoPor && <div style={{ fontSize: 10.5, fontWeight: 800, color: C.amber, marginBottom: 4 }}>MINUTA — sujeita a revisão e aprovação do responsável técnico</div>}
      <div style={{ fontSize: 11.5, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{analise?.texto || "Sem análise registrada para a data."}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 22, marginTop: 40, breakInside: "avoid" }}>
        {["Fiscal de qualidade — usina", "Fiscal de qualidade — pista", "Coordenação Solocontrol"].map((r) => (
          <div key={r} style={{ textAlign: "center" }}><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 5, fontSize: 10.5 }}>{r}</div></div>
        ))}
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Documento gerado pelo Solocontrol 360 em {fmtDataHora()} · Nº {numero} · Registros assinados digitalmente por usuário autenticado.
      </div>
    </Impressao>
  );
}

// ----------------------------------------------------------------------------
// Resumo geral da OBRA (do início ao fim da execução)
// ----------------------------------------------------------------------------
function ResumoObra({ obra, cargas, fechs, fechar }) {
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
    <Impressao fechar={fechar}>
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
        Documento gerado pelo Solocontrol 360 em {fmtDataHora()} · Consolida {ord.length} cargas e {fechs.length} fechamento(s) diário(s) registrados em nuvem.
      </div>
    </Impressao>
  );
}

// ============================================================================
// RAIZ DO APP
// ============================================================================
export default function App() {
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
    return [{ id: "boletins", ico: "📋", rot: "Boletins" }, { id: "fechamento", ico: "🔒", rot: "Fechar dia" }];
  }, [perfil?.papel]);
  useEffect(() => { if (abas.length && !abas.find((a) => a.id === aba)) setAba(abas[0].id); }, [abas]);

  if (user === undefined) return null;
  if (!user) return <><EstiloGlobal /><TelaLogin /></>;
  if (!perfil) return null;
  if (perfil.semPerfil) return <Aviso txt="Seu acesso ainda não tem perfil configurado. Peça ao coordenador para cadastrar você em Equipe." />;
  if (perfil.ativo === false) return <Aviso txt="Acesso desativado pela coordenação." sair />;

  return (
    <>
      <EstiloGlobal />
      <Shell perfil={perfil} abas={abas} aba={aba} setAba={setAba}>
        {perfil.papel === "coordenador" && <TelaCoordenador perfil={perfil} aba={aba} />}
        {perfil.papel === "usina" && (
          aba === "nova" ? <UsinaNovaCarga perfil={perfil} /> :
          aba === "dia" ? <UsinaCargasDia perfil={perfil} /> :
          aba === "ensaios" ? <EnsaiosUsina perfil={perfil} /> : <ResumoUsina perfil={perfil} />
        )}
        {perfil.papel === "obra" && <TelaObra perfil={perfil} aba={aba} />}
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
      .area-impressao { position: absolute !important; inset: 0; overflow: visible !important; }
      .nao-imprimir { display: none !important; }
      @page { size: A4; margin: 12mm; }
    }
  `}</style>
);

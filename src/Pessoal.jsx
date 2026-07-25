// ============================================================================
// SOLOCONTROL 360 · MÓDULO PESSOAL
// Cartão de ponto eletrônico + documentos de SST (ASO · PCMSO · PGR · EPI)
// + controle de férias e admissão
// ----------------------------------------------------------------------------
// PREMISSAS LEGAIS ADOTADAS (todas configuráveis em Pessoal › Parâmetros):
//
// 1. TOLERÂNCIA — CLT art. 58, §1º e Súmula 366 do TST: variações de até 5 min
//    por marcação, limitadas a 10 min/dia, não são computadas. ULTRAPASSADO o
//    limite, conta-se a TOTALIDADE do tempo excedente à jornada (não apenas o
//    que passou dos 10 min). É o modo padrão ("sumula366").
//    O modo "excedente" (descontar os 10 min) existe apenas por configuração e
//    NÃO é o entendimento consolidado do TST — use somente com respaldo da CCT.
//
// 2. ADICIONAIS — os percentuais (70% em dia útil, 110% em fim de semana) são
//    PARÂMETROS, não constantes de código. O mínimo legal é 50% (CLT art. 7º,
//    XVI) e 100% no domingo/feriado sem folga compensatória (Súmula 146 do TST).
//    Ajuste conforme a CCT vigente e registre o nº do Mediador/MTE nos parâmetros.
//
// 3. INTERVALO — art. 71: jornada acima de 6 h exige 1 h de intervalo. O sistema
//    exige 4 marcações (entrada · saída almoço · volta almoço · saída) e sinaliza
//    supressão para apuração da indenização de 50% pela folha.
//
// 4. REGISTRO — Portaria MTP 671/2021: as marcações são APPEND-ONLY (nunca
//    editadas nem apagadas), recebem NSR sequencial por empregado, geram
//    comprovante ao trabalhador e nunca são bloqueadas pelo sistema. Correções
//    entram como lançamento de ajuste assinado pela coordenação, preservando a
//    marcação original. Para valer como REP-P homologado, o conjunto ainda
//    depende de exportação AFD certificada; sem isso, formalize o uso como
//    sistema alternativo de controle em acordo/convenção coletiva.
// ============================================================================
import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { db, storage, firebaseConfig } from "./firebase";
import { getAuth, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { initializeApp, getApps } from "firebase/app";
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, getDocs, arrayUnion, increment,
} from "firebase/firestore";

// ============================================================================
// KIT VISUAL PRÓPRIO (autossuficiente — Pessoal.jsx NÃO depende de App.jsx)
// Mesma identidade visual do sistema. Se um dia você padronizar num arquivo
// "ui.jsx" único, é só apontar os imports para lá.
// ============================================================================
export const C = {
  navy: "#16255F", navy2: "#0F1A45", red: "#D62A2A", amber: "#B45309",
  bg: "#EEF1F7", card: "#FFFFFF", line: "#DDE3EF", ink: "#1B2233",
  mut: "#5C6577", ok: "#15803D", okBg: "#E7F6EC", warnBg: "#FEF3E2",
  redBg: "#FDEAEA", blue: "#1D4ED8", blueBg: "#E8EFFD", pur: "#6D28D9",
  purBg: "#F1EBFD", grayBg: "#EEF1F7",
};
export const F = {
  disp: "'Barlow Semi Condensed', 'Arial Narrow', sans-serif",
  body: "'Inter', -apple-system, 'Segoe UI', sans-serif",
};

export const hojeISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const agoraHM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const agoraISO = () => new Date().toISOString();
export const fmtBR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
export const fmtDataHora = () => {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const num = (v) => { const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? null : n; };
const rid = () => Math.random().toString(36).slice(2, 10);

// GPS → UTM (WGS84), mesmo padrão das fotos de campo
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
export const pegarGPS = () => new Promise((res) => {
  if (!navigator.geolocation) return res(null);
  navigator.geolocation.getCurrentPosition(
    (p) => res(paraUTM(p.coords.latitude, p.coords.longitude)),
    () => res(null),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
  );
});

export const Logo = ({ s = 34 }) => (
  <img src="/marca.png" alt="Solocontrol" width={s} height={s}
    style={{ display: "block", background: "#fff", borderRadius: Math.round(s * 0.22), padding: Math.round(s * 0.1), boxSizing: "border-box", objectFit: "contain" }} />
);
export const Btn = ({ children, tom = "navy", cheio = true, ...p }) => (
  <button {...p} style={{
    fontFamily: F.body, fontWeight: 700, fontSize: 15, cursor: "pointer",
    borderRadius: 12, padding: "13px 18px", width: cheio ? "100%" : "auto",
    background: tom === "navy" ? C.navy : tom === "red" ? C.red : tom === "ok" ? C.ok : tom === "claro" ? "#fff" : C.grayBg,
    color: tom === "claro" || tom === "cinza" ? C.navy : "#fff",
    border: tom === "claro" ? `1.5px solid ${C.line}` : "none",
    opacity: p.disabled ? 0.5 : 1, ...p.style,
  }}>{children}</button>
);
export const Campo = ({ rotulo, sufixo, ...p }) => (
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
export const Sel = ({ rotulo, children, ...p }) => (
  <label style={{ display: "block", marginBottom: 12 }}>
    <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.mut, marginBottom: 5 }}>{rotulo}</span>
    <select {...p} style={{
      width: "100%", boxSizing: "border-box", fontFamily: F.body, fontSize: 16, color: C.ink,
      padding: "12px 10px", borderRadius: 11, border: `1.5px solid ${C.line}`, background: "#fff", ...p.style,
    }}>{children}</select>
  </label>
);
export const Cartao = ({ children, style }) => (
  <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.line}`, marginBottom: 12, ...style }}>{children}</div>
);
export const Titulo = ({ children, sub }) => (
  <div style={{ margin: "4px 2px 12px" }}>
    <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 22, color: C.navy, textTransform: "uppercase", letterSpacing: 0.3 }}>{children}</div>
    {sub && <div style={{ fontSize: 13, color: C.mut, marginTop: 2 }}>{sub}</div>}
  </div>
);
export const Linha = ({ k, v, forte }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", fontSize: 14, borderBottom: `1px dashed ${C.line}` }}>
    <span style={{ color: C.mut }}>{k}</span>
    <span style={{ fontWeight: forte ? 800 : 600, color: forte ? C.navy : C.ink, textAlign: "right" }}>{v}</span>
  </div>
);

export const secRel = { fontFamily: F.disp, fontWeight: 800, fontSize: 14, color: C.navy, textTransform: "uppercase", borderBottom: `2px solid ${C.red}`, padding: "3px 0", margin: "16px 0 8px" };
export const tabTh = { textAlign: "left", padding: "5px 6px", fontSize: 10.5, color: "#fff", background: C.navy };
export const tabTd = { padding: "5px 6px", fontSize: 11, borderBottom: `1px solid ${C.line}` };

const ehStandalone = () => (typeof window !== "undefined") &&
  (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true);

// Geração de PDF dentro do app (mesma máquina do restante do sistema)
async function gerarPDF(nomeArquivo, aviso) {
  const area = document.querySelector(".area-impressao");
  if (!area) return;
  aviso("Carregando gerador…");
  const [{ jsPDF }, h2c] = await Promise.all([import("jspdf"), import("html2canvas")]);
  const html2canvas = h2c.default;
  const clone = area.cloneNode(true);
  clone.querySelectorAll(".nao-imprimir").forEach((el) => el.remove());
  clone.querySelectorAll("textarea").forEach((t) => t.remove());
  const caixa = document.createElement("div");
  caixa.style.cssText = "position:fixed;left:-10000px;top:0;width:820px;background:#fff;padding:26px;box-sizing:border-box;font-family:Inter,sans-serif";
  caixa.appendChild(clone);
  document.body.appendChild(caixa);
  try {
    aviso("Montando o documento…");
    const areaPx = caixa.scrollWidth * caixa.scrollHeight;
    const escala = Math.max(1, Math.min(2, Math.sqrt(14000000 / Math.max(areaPx, 1))));
    const canvas = await html2canvas(caixa, { scale: escala, useCORS: true, backgroundColor: "#ffffff", logging: false, imageTimeout: 20000 });
    const pdf = new jsPDF({ unit: "mm", format: "a4" });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const mg = 8, larg = pw - mg * 2, alt = ph - mg * 2;
    const pxMm = canvas.width / larg;
    const alturaPagina = Math.floor(alt * pxMm);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const linhaLimpa = (y) => {
      try {
        const d = ctx.getImageData(0, y, canvas.width, 1).data;
        for (let x = 0; x < canvas.width; x += 8) {
          const p = x * 4;
          if (d[p] < 246 || d[p + 1] < 246 || d[p + 2] < 246) return false;
        }
        return true;
      } catch { return true; }
    };
    const cortePara = (inicio) => {
      const ideal = inicio + alturaPagina;
      if (ideal >= canvas.height) return canvas.height;
      const limite = Math.floor(alturaPagina * 0.22);
      for (let d = 0; d < limite; d++) {
        const y = ideal - d;
        if (y <= inicio + 40) break;
        if (linhaLimpa(y) && linhaLimpa(y - 3) && linhaLimpa(y + 3)) return y;
      }
      return ideal;
    };
    let y = 0, pag = 0;
    while (y < canvas.height) {
      const fim = cortePara(y);
      const fatia = fim - y;
      const c2 = document.createElement("canvas");
      c2.width = canvas.width; c2.height = fatia;
      const cc = c2.getContext("2d");
      cc.fillStyle = "#ffffff"; cc.fillRect(0, 0, c2.width, c2.height);
      cc.drawImage(canvas, 0, y, canvas.width, fatia, 0, 0, canvas.width, fatia);
      if (pag) pdf.addPage();
      pdf.addImage(c2.toDataURL("image/jpeg", 0.88), "JPEG", mg, mg, larg, fatia / pxMm);
      y = fim; pag++;
      aviso(`Montando página ${pag}…`);
    }
    const blob = pdf.output("blob");
    const arquivo = new File([blob], nomeArquivo, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {
      aviso("Abrindo compartilhamento…");
      await navigator.share({ files: [arquivo], title: nomeArquivo });
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = nomeArquivo; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  } catch (e) {
    if (e?.name !== "AbortError") alert("Não foi possível gerar o PDF. Tente de novo com o app aberto e conectado.");
  } finally {
    caixa.remove();
    aviso("");
  }
}
function BotaoPDF({ nome, estilo }) {
  const [msg, setMsg] = useState("");
  return (
    <Btn tom="red" cheio={false} disabled={!!msg} onClick={() => gerarPDF(nome, setMsg)} style={estilo}>
      {msg || "📤 Exportar / enviar PDF"}
    </Btn>
  );
}
export function Impressao({ children, fechar, nomeArquivo = "documento-solocontrol.pdf" }) {
  return createPortal(
    <div className="area-impressao" style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 100, overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
      <div className="nao-imprimir" style={{ position: "sticky", top: 0, display: "flex", gap: 8, padding: 10, background: C.navy, zIndex: 5, flexWrap: "wrap" }}>
        <BotaoPDF nome={nomeArquivo} estilo={{ flex: 1, minWidth: 170 }} />
        {!ehStandalone() && <Btn tom="claro" cheio={false} onClick={() => window.print()} style={{ padding: "13px 16px" }}>🖨️ Imprimir</Btn>}
        <Btn tom="claro" cheio={false} onClick={fechar} style={{ padding: "13px 18px" }}>Fechar</Btn>
      </div>
      <div style={{ maxWidth: 780, margin: "0 auto", padding: "18px 20px 60px", fontFamily: F.body, color: C.ink }}>{children}</div>
    </div>, document.body);
}


// ----------------------------------------------------------------------------
// Identificação do empregador (aparece no comprovante e no espelho de ponto)
// ----------------------------------------------------------------------------
export const EMPREGADOR = {
  razao: "SOLOCONTROL ENGENHARIA E CONSULTORIA",
  cnpj: "56.385.353/0001-01",
  endereco: "Rua Francisco Martimiano de Oliveira, 275 — Centro — Américo Brasiliense/SP",
};

// ----------------------------------------------------------------------------
// Parâmetros padrão — TODOS editáveis pela coordenação
// ----------------------------------------------------------------------------
const CFG_PADRAO = {
  ponto: {
    toleranciaMarcacaoMin: 5,    // CLT art. 58 §1º
    toleranciaDiaMin: 10,        // CLT art. 58 §1º
    modoTolerancia: "sumula366", // "sumula366" (correto) | "excedente"
    pctNormal: 70,               // hora extra em dia útil
    pctFimSemana: 110,           // sábado/domingo não previstos na escala
    pctFeriado: 110,
    adicNoturno: 20,             // CLT art. 73
    horaNoturnaReduzida: true,   // hora noturna = 52min30s
    horasMes: 220,               // divisor para valor-hora (44h semanais)
    intervaloMinimoMin: 60,
    cct: { sindicato: "", mediador: "", vigencia: "" },
  },
  sst: { pcmso: { validade: "", responsavel: "" }, pgr: [] },
  feriados: [],
};

// Jornada padrão: 44h semanais com sábado compensado (8h48 de segunda a sexta).
// Assim, trabalho em sábado/domingo cai automaticamente no adicional de fim de semana.
const REGIME_PADRAO = {
  dias: { seg: 528, ter: 528, qua: 528, qui: 528, sex: 528, sab: 0, dom: 0 },
  intervaloMin: 60,
  entradaRef: "07:00",
};
const DIA_SEM = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
const DIA_ROT = { dom: "Dom", seg: "Seg", ter: "Ter", qua: "Qua", qui: "Qui", sex: "Sex", sab: "Sáb" };

const TIPOS_MARCA = [
  { id: "entrada", rot: "Entrada", ico: "▶️", cor: "#15803D" },
  { id: "saida_almoco", rot: "Saída para almoço", ico: "🍽️", cor: "#B45309" },
  { id: "volta_almoco", rot: "Volta do almoço", ico: "↩️", cor: "#1D4ED8" },
  { id: "saida", rot: "Saída", ico: "⏹️", cor: "#D62A2A" },
];
const rotMarca = (t) => (TIPOS_MARCA.find((x) => x.id === t) || { rot: t }).rot;

// ----------------------------------------------------------------------------
// Utilidades de data e hora
// ----------------------------------------------------------------------------
const dataDe = (s) => new Date(`${s}T12:00:00`);
const isoDe = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addMeses = (s, n) => {
  const d = dataDe(s), dia = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() < dia) d.setDate(0);
  return isoDe(d);
};
const diasEntre = (a, b) => Math.round((dataDe(b) - dataDe(a)) / 86400000);
const hm = (s) => { const [a, b] = String(s).split(":").map(Number); return (a || 0) * 60 + (b || 0); };
const hhmm = (min) => {
  if (min == null || isNaN(min)) return "—";
  const s = min < 0 ? "-" : "";
  const m = Math.abs(Math.round(min));
  return `${s}${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const mesRef = (d = hojeISO()) => d.slice(0, 7);
const diasDoMes = (ym) => {
  const [a, m] = ym.split("-").map(Number);
  const n = new Date(a, m, 0).getDate();
  return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
};
const rotMes = (ym) => {
  const M = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const [a, m] = ym.split("-").map(Number);
  return `${M[m - 1]}/${a}`;
};

// ----------------------------------------------------------------------------
// Situação de validade: vencido · a vencer (≤ 30 dias) · em dia
// ----------------------------------------------------------------------------
export function situacaoValidade(validade, hoje = hojeISO(), aviso = 30) {
  if (!validade) return { st: "sem", rot: "Não informado", cor: C.mut, bg: C.grayBg, dias: null };
  const d = diasEntre(hoje, validade);
  if (d < 0) return { st: "vencido", rot: `Vencido há ${Math.abs(d)} dia(s)`, cor: C.red, bg: C.redBg, dias: d };
  if (d <= aviso) return { st: "vencendo", rot: `Vence em ${d} dia(s)`, cor: C.amber, bg: C.warnBg, dias: d };
  return { st: "ok", rot: `Válido até ${fmtBR(validade)}`, cor: C.ok, bg: C.okBg, dias: d };
}

// ----------------------------------------------------------------------------
// Férias — período aquisitivo (12 meses) e concessivo (12 meses seguintes).
// Vencido o concessivo sem gozo, incide a dobra do art. 137 da CLT.
// ----------------------------------------------------------------------------
export function situacaoFerias(admissao, gozadas = [], hoje = hojeISO()) {
  if (!admissao) return { st: "sem", rot: "Admissão não informada", cor: C.mut, bg: C.grayBg };
  const usados = gozadas.filter((f) => f?.inicio).length;
  const n = usados + 1;                              // próximo período a ser gozado
  const aquisitivoIni = addMeses(admissao, 12 * (n - 1));
  const aquisitivoFim = addMeses(admissao, 12 * n);
  const concessivoFim = addMeses(admissao, 12 * (n + 1));
  if (diasEntre(hoje, aquisitivoFim) > 0) {
    return {
      st: "adquirindo", cor: C.mut, bg: C.grayBg, aquisitivoIni, aquisitivoFim, concessivoFim,
      rot: `Período aquisitivo até ${fmtBR(aquisitivoFim)}`,
    };
  }
  const d = diasEntre(hoje, concessivoFim);
  if (d < 0) return {
    st: "dobra", cor: C.red, bg: C.redBg, aquisitivoIni, aquisitivoFim, concessivoFim,
    rot: `VENCIDAS há ${Math.abs(d)} dia(s) — pagamento em dobro (art. 137)`,
  };
  if (d <= 90) return {
    st: "urgente", cor: C.red, bg: C.redBg, aquisitivoIni, aquisitivoFim, concessivoFim,
    rot: `Conceder em até ${d} dia(s) — prazo final ${fmtBR(concessivoFim)}`,
  };
  if (d <= 180) return {
    st: "atencao", cor: C.amber, bg: C.warnBg, aquisitivoIni, aquisitivoFim, concessivoFim,
    rot: `Programar férias — prazo final ${fmtBR(concessivoFim)}`,
  };
  return {
    st: "ok", cor: C.ok, bg: C.okBg, aquisitivoIni, aquisitivoFim, concessivoFim,
    rot: `Direito adquirido — conceder até ${fmtBR(concessivoFim)}`,
  };
}

// ----------------------------------------------------------------------------
// Apuração de um dia de trabalho
// ----------------------------------------------------------------------------
function paresDoDia(marcacoes = []) {
  const ms = [...marcacoes].sort((a, b) => (a.em || "").localeCompare(b.em || "") || String(a.hora).localeCompare(String(b.hora)));
  const pares = []; let base = null, anterior = null, offset = 0;
  ms.forEach((m) => {
    let v = hm(m.hora);
    if (anterior != null && v < anterior) offset += 1440; // virada de dia (turno noturno)
    anterior = v;
    v += offset;
    if (base == null) base = v; else { pares.push([base, v]); base = null; }
  });
  return { ms, pares, aberto: base, impar: base != null };
}

// Faixas noturnas (CLT art. 73): 22:00–05:00. Minutos contados a partir das
// 00:00 do dia da entrada — por isso a segunda faixa vai até 1740 (05:00 do dia seguinte).
function minutosNoturnos(ini, fim) {
  let t = 0;
  [[0, 300], [1320, 1740]].forEach(([a, b]) => {
    t += Math.max(0, Math.min(fim, b) - Math.max(ini, a));
  });
  return t;
}

export function calcularDia({ dataRef, marcacoes = [], regime, cfg, feriado, afastamento }) {
  const p = cfg?.ponto || CFG_PADRAO.ponto;
  const rg = { ...REGIME_PADRAO, ...(regime || {}) };
  const chave = DIA_SEM[dataDe(dataRef).getDay()];
  const prevista = feriado ? 0 : (rg.dias?.[chave] ?? 0);
  const { ms, pares, impar } = paresDoDia(marcacoes);

  const trabalhado = pares.reduce((s, [a, b]) => s + (b - a), 0);
  const noturno = pares.reduce((s, [a, b]) => s + minutosNoturnos(a, b), 0);
  let intervalo = 0;
  for (let i = 1; i < pares.length; i++) intervalo += pares[i][0] - pares[i - 1][1];

  let extraNormal = 0, extraEspecial = 0, debito = 0, tolerado = 0;
  const pctEspecial = feriado ? p.pctFeriado : p.pctFimSemana;

  if (prevista > 0) {
    const saldo = trabalhado - prevista;
    if (saldo > 0) {
      if (saldo <= p.toleranciaDiaMin) tolerado = saldo;
      else extraNormal = p.modoTolerancia === "excedente" ? saldo - p.toleranciaDiaMin : saldo;
    } else if (saldo < 0) {
      const atraso = -saldo;
      if (atraso <= p.toleranciaDiaMin) tolerado = -atraso;
      else debito = p.modoTolerancia === "excedente" ? atraso - p.toleranciaDiaMin : atraso;
    }
  } else if (trabalhado > 0) {
    extraEspecial = trabalhado;
  }

  const avisos = [];
  if (impar) avisos.push("Marcação ímpar — falta registrar a saída.");
  if (ms.length && ms.length !== 4 && !impar && prevista > 0)
    avisos.push(`${ms.length} marcação(ões) no dia — o padrão são 4 (entrada, almoço ida/volta, saída).`);
  if (trabalhado > 360 && intervalo > 0 && intervalo < (p.intervaloMinimoMin || 60))
    avisos.push(`Intervalo de ${hhmm(intervalo)} — inferior ao mínimo legal de 1 h (art. 71). Apurar indenização de 50%.`);
  if (trabalhado > 360 && intervalo === 0 && pares.length === 1)
    avisos.push("Jornada acima de 6 h sem intervalo registrado (art. 71).");
  if (trabalhado > 600) avisos.push("Jornada acima de 10 h — limite de 2 h extras diárias (art. 59).");
  if (prevista > 0 && !ms.length && !afastamento) avisos.push("Dia útil sem marcação — falta ou afastamento a justificar.");

  return {
    dataRef, chave, feriado: !!feriado, afastamento: afastamento || "",
    prevista, trabalhado, intervalo, noturno, pares, marcacoes: ms, impar,
    extraNormal, extraEspecial, pctEspecial, debito, tolerado, avisos,
    saldo: trabalhado - prevista,
  };
}

// ----------------------------------------------------------------------------
// Apuração do mês
// ----------------------------------------------------------------------------
export function calcularMes({ ym, dias, func, cfg }) {
  const p = cfg?.ponto || CFG_PADRAO.ponto;
  const feriados = Object.fromEntries((cfg?.feriados || []).map((f) => [f.data, f.nome || "Feriado"]));
  const regime = func?.regime || REGIME_PADRAO;
  const linhas = diasDoMes(ym).map((d) => calcularDia({
    dataRef: d,
    marcacoes: dias[d]?.marcacoes || [],
    regime, cfg,
    feriado: feriados[d],
    afastamento: dias[d]?.afastamento,
  }));

  const soma = (k) => linhas.reduce((s, l) => s + (l[k] || 0), 0);
  const t = {
    previsto: soma("prevista"), trabalhado: soma("trabalhado"), noturno: soma("noturno"),
    extraNormal: soma("extraNormal"), extraEspecial: soma("extraEspecial"), debito: soma("debito"),
    diasComRegistro: linhas.filter((l) => l.marcacoes.length).length,
    diasUteis: linhas.filter((l) => l.prevista > 0).length,
    diasDescanso: linhas.filter((l) => l.prevista === 0).length,
    faltas: linhas.filter((l) => l.prevista > 0 && !l.marcacoes.length && !l.afastamento).length,
    avisos: linhas.filter((l) => l.avisos.length).length,
  };
  t.saldo = t.trabalhado - t.previsto;

  // Reflexo do DSR sobre horas extras (Súmula 172 do TST) — informativo
  const extrasTot = t.extraNormal + t.extraEspecial;
  t.dsr = t.diasUteis > 0 ? (extrasTot / t.diasUteis) * t.diasDescanso : 0;

  // Estimativa de valores — CONFERÊNCIA apenas; a folha é do escritório contábil
  const salario = num(func?.salario);
  if (salario != null && salario > 0) {
    const vh = salario / (p.horasMes || 220);
    t.valorHora = vh;
    t.vlExtraNormal = (t.extraNormal / 60) * vh * (1 + p.pctNormal / 100);
    t.vlExtraEspecial = (t.extraEspecial / 60) * vh * (1 + p.pctFimSemana / 100);
    t.vlNoturno = (t.noturno / 60) * vh * (p.adicNoturno / 100);
    t.vlDsr = (t.dsr / 60) * vh * (1 + p.pctNormal / 100);
    t.vlTotal = t.vlExtraNormal + t.vlExtraEspecial + t.vlNoturno + t.vlDsr;
  }
  return { linhas, t };
}

const brl = (v) => (v == null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));

// ----------------------------------------------------------------------------
// Hooks de dados
// ----------------------------------------------------------------------------
export function useConfigPessoal() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => onSnapshot(doc(db, "empresa", "config"), (s) => {
    const d = s.data() || {};
    setCfg({
      ponto: { ...CFG_PADRAO.ponto, ...(d.ponto || {}), cct: { ...CFG_PADRAO.ponto.cct, ...(d.ponto?.cct || {}) } },
      sst: { ...CFG_PADRAO.sst, ...(d.sst || {}) },
      feriados: d.feriados || [],
    });
  }, () => setCfg(CFG_PADRAO)), []);
  return cfg;
}
export function useFuncionarios(apenasAtivos = false) {
  const [l, setL] = useState([]);
  useEffect(() => onSnapshot(collection(db, "funcionarios"), (s) => {
    const a = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
    a.sort((x, y) => (x.nome || "").localeCompare(y.nome || ""));
    setL(apenasAtivos ? a.filter((f) => f.ativo !== false) : a);
  }), [apenasAtivos]);
  return l;
}
export function useFuncionario(uid) {
  const [f, setF] = useState(null);
  useEffect(() => {
    if (!uid) return setF(null);
    return onSnapshot(doc(db, "funcionarios", uid), (s) => setF(s.exists() ? { uid, ...s.data() } : { uid, semCadastro: true }));
  }, [uid]);
  return f;
}
function usePontoDia(uid, dataRef) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (!uid) return setD(null);
    return onSnapshot(doc(db, "ponto", `${uid}_${dataRef}`), (s) => setD(s.exists() ? s.data() : { marcacoes: [] }));
  }, [uid, dataRef]);
  return d;
}
function usePontoMes(uid, ym) {
  const [m, setM] = useState({});
  useEffect(() => {
    if (!uid) return setM({});
    const ini = `${ym}-01`, fim = `${ym}-31`;
    return onSnapshot(
      query(collection(db, "ponto"), where("uid", "==", uid), where("dataRef", ">=", ini), where("dataRef", "<=", fim)),
      (s) => setM(Object.fromEntries(s.docs.map((d) => [d.data().dataRef, d.data()])))
    );
  }, [uid, ym]);
  return m;
}

// Banco de horas acumulado: soma o saldo de todos os meses do início do
// registro até o mês pedido, mais o saldo inicial informado na admissão do
// sistema (para quem já tinha crédito/débito antes de começar a bater ponto).
// Retorna { carregando, saldoAcumulado, ateMes, saldoInicial }.
export function useBancoHoras(uid, func, cfg, ymAte = mesRef()) {
  const [r, setR] = useState({ carregando: true, saldoAcumulado: 0, ateMes: ymAte, saldoInicial: 0 });
  useEffect(() => {
    if (!uid || !cfg) return;
    let vivo = true;
    (async () => {
      setR((x) => ({ ...x, carregando: true }));
      const inicial = num(func?.saldoInicialMin) || 0; // minutos; positivo = crédito
      // Todas as marcações do funcionário até o fim do mês pedido
      const s = await getDocs(query(
        collection(db, "ponto"),
        where("uid", "==", uid),
        where("dataRef", "<=", `${ymAte}-31`),
      ));
      const porMes = {};
      s.docs.forEach((d) => { const x = d.data(); (porMes[mesRef(x.dataRef)] ||= {})[x.dataRef] = x; });
      let acc = inicial;
      Object.keys(porMes).sort().forEach((ym) => {
        acc += calcularMes({ ym, dias: porMes[ym], func, cfg }).t.saldo;
      });
      if (vivo) setR({ carregando: false, saldoAcumulado: acc, ateMes: ymAte, saldoInicial: inicial });
    })().catch(() => vivo && setR((x) => ({ ...x, carregando: false })));
    return () => { vivo = false; };
  }, [uid, func?.saldoInicialMin, func?.regime, cfg, ymAte]);
  return r;
}

// ----------------------------------------------------------------------------
// Gravação da marcação — APPEND-ONLY, nunca sobrescreve nem apaga
// ----------------------------------------------------------------------------
async function registrarMarcacao({ perfil, func, tipo }) {
  const dataRef = hojeISO();
  const nsr = (func?.nsr || 0) + 1;
  const marca = {
    nsr, tipo, hora: agoraHM(), em: agoraISO(),
    utm: (await pegarGPS()) || "", origem: "PWA Solocontrol 360",
    disp: (navigator.userAgent || "").slice(0, 90),
  };
  setDoc(doc(db, "ponto", `${perfil.uid}_${dataRef}`), {
    uid: perfil.uid, nome: perfil.nome, dataRef,
    matricula: func?.matricula || "", cpf: func?.cpf || "",
    marcacoes: arrayUnion(marca), atualizadoEm: agoraISO(),
  }, { merge: true }).catch(() => {});
  updateDoc(doc(db, "funcionarios", perfil.uid), { nsr: increment(1), ultimaMarcacao: marca.em }).catch(() => {});
  return marca;
}

// ============================================================================
// TELA DO FUNCIONÁRIO — bater o ponto
// ============================================================================
export function TelaPonto({ perfil }) {
  const cfg = useConfigPessoal();
  const func = useFuncionario(perfil.uid);
  const hoje = hojeISO();
  const pd = usePontoDia(perfil.uid, hoje);
  const [ym, setYm] = useState(mesRef());
  const mes = usePontoMes(perfil.uid, ym);
  const [comprovante, setComprovante] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [verMes, setVerMes] = useState(false);

  const marcacoes = pd?.marcacoes || [];
  const proximo = TIPOS_MARCA[marcacoes.length] || null;
  const dia = useMemo(() => calcularDia({
    dataRef: hoje, marcacoes, regime: func?.regime, cfg,
    feriado: (cfg?.feriados || []).find((f) => f.data === hoje)?.nome,
  }), [marcacoes.length, cfg, func?.regime]);

  const bater = async (tipo) => {
    setOcupado(true);
    try {
      const m = await registrarMarcacao({ perfil, func, tipo });
      setComprovante(m);
    } finally { setOcupado(false); }
  };

  if (!cfg) return <Cartao><div style={{ color: C.mut, textAlign: "center" }}>Carregando…</div></Cartao>;

  const st = marcacoes.length === 0 ? { rot: "Fora do expediente", cor: C.mut, bg: C.grayBg }
    : marcacoes.length === 1 ? { rot: "Trabalhando", cor: C.ok, bg: C.okBg }
    : marcacoes.length === 2 ? { rot: "Em intervalo", cor: C.amber, bg: C.warnBg }
    : marcacoes.length === 3 ? { rot: "Trabalhando", cor: C.ok, bg: C.okBg }
    : { rot: "Jornada encerrada", cor: C.blue, bg: C.blueBg };

  return (
    <>
      <Titulo sub={`${fmtBR(hoje)} · ${DIA_ROT[dia.chave]}${dia.feriado ? ` · feriado` : ""}`}>Cartão de ponto</Titulo>

      <Cartao style={{ background: st.bg, borderColor: st.cor + "44" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 800, color: st.cor, fontSize: 15 }}>{st.rot}</div>
            <div style={{ fontSize: 12.5, color: C.mut, marginTop: 2 }}>
              {perfil.nome}{func?.matricula ? ` · matrícula ${func.matricula}` : ""}
            </div>
          </div>
          <RelogioPonto />
        </div>
      </Cartao>

      <CardBanco uid={perfil.uid} func={func} cfg={cfg} />

      {proximo ? (
        <Btn tom={proximo.id === "saida" ? "red" : proximo.id === "saida_almoco" ? "cinza" : "ok"}
          onClick={() => bater(proximo.id)} disabled={ocupado}
          style={{ padding: "26px 18px", fontSize: 19, marginBottom: 12 }}>
          {ocupado ? "Registrando…" : `${proximo.ico}  ${proximo.rot}`}
        </Btn>
      ) : (
        <Cartao style={{ background: C.blueBg, borderColor: "#C6D6F7" }}>
          <div style={{ fontWeight: 700, color: C.blue, textAlign: "center" }}>✅ As 4 marcações do dia foram registradas.</div>
        </Cartao>
      )}

      {/* O sistema nunca bloqueia marcação — Portaria MTP 671/2021 */}
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 13, color: C.mut, fontWeight: 600, cursor: "pointer", padding: "6px 2px" }}>
          Preciso registrar outra marcação neste dia
        </summary>
        <Cartao style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12.5, color: C.mut, marginBottom: 10 }}>
            O sistema não bloqueia marcações extras (retorno ao serviço, jornada dividida, hora extra).
            Toda marcação fica registrada e a coordenação apura na conferência do mês.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {TIPOS_MARCA.map((t) => (
              <Btn key={t.id} tom="claro" onClick={() => bater(t.id)} disabled={ocupado} style={{ padding: "11px 8px", fontSize: 13 }}>
                {t.ico} {t.rot}
              </Btn>
            ))}
          </div>
        </Cartao>
      </details>

      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 8 }}>Marcações de hoje</div>
        {!marcacoes.length && <div style={{ color: C.mut, fontSize: 13.5, textAlign: "center", padding: 8 }}>Nenhuma marcação registrada hoje.</div>}
        {marcacoes.map((m) => (
          <div key={m.nsr} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px dashed ${C.line}` }}>
            <span style={{ fontSize: 13.5 }}>
              <b style={{ fontFamily: F.disp, fontSize: 17, color: C.navy }}>{m.hora}</b>
              <span style={{ color: C.mut, marginLeft: 8 }}>{rotMarca(m.tipo)}</span>
            </span>
            <button onClick={() => setComprovante(m)} style={{ background: "none", border: "none", color: C.blue, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
              NSR {m.nsr} · comprovante
            </button>
          </div>
        ))}
        {marcacoes.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <Linha k="Trabalhado até agora" v={hhmm(dia.trabalhado)} forte />
            <Linha k="Jornada prevista" v={dia.prevista ? hhmm(dia.prevista) : "sem jornada (descanso)"} />
            {dia.intervalo > 0 && <Linha k="Intervalo" v={hhmm(dia.intervalo)} />}
          </div>
        )}
        {dia.avisos.map((a, i) => (
          <div key={i} style={{ background: C.warnBg, color: C.amber, fontSize: 12.5, fontWeight: 600, borderRadius: 9, padding: "7px 11px", marginTop: 8 }}>⚠️ {a}</div>
        ))}
      </Cartao>

      <Btn tom="claro" onClick={() => setVerMes(!verMes)}>{verMes ? "Ocultar" : "📅 Ver meu espelho do mês"}</Btn>
      {verMes && <MeuEspelho perfil={perfil} func={func} cfg={cfg} ym={ym} setYm={setYm} mes={mes} />}

      {comprovante && <Comprovante m={comprovante} perfil={perfil} func={func} fechar={() => setComprovante(null)} />}
    </>
  );
}

// Card de saldo (banco de horas) — mostra ao funcionário se está positivo ou
// negativo, somando todos os meses. Card de destaque no topo do cartão de ponto.
function CardBanco({ uid, func, cfg }) {
  const b = useBancoHoras(uid, func, cfg);
  if (!cfg) return null;
  const positivo = b.saldoAcumulado >= 0;
  const zerado = Math.abs(b.saldoAcumulado) < 1;
  const cor = zerado ? C.mut : positivo ? C.ok : C.red;
  const bg = zerado ? C.grayBg : positivo ? C.okBg : C.redBg;
  return (
    <Cartao style={{ background: bg, borderColor: cor + "44" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.mut, textTransform: "uppercase", letterSpacing: 0.5 }}>Banco de horas</div>
          <div style={{ fontSize: 12.5, color: C.mut, marginTop: 3 }}>
            {b.carregando ? "Somando os meses…" : zerado ? "Você está em dia" : positivo ? "Saldo a seu favor" : "Horas a compensar"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 30, color: cor, lineHeight: 1 }}>
            {b.carregando ? "…" : `${positivo && !zerado ? "+" : ""}${hhmm(b.saldoAcumulado)}`}
          </div>
          {!b.carregando && !zerado && (
            <div style={{ fontSize: 11, fontWeight: 700, color: cor, marginTop: 2 }}>
              {positivo ? "▲ positivo" : "▼ negativo"}
            </div>
          )}
        </div>
      </div>
      {!b.carregando && b.saldoInicial !== 0 && (
        <div style={{ fontSize: 11, color: C.mut, marginTop: 8, borderTop: `1px dashed ${cor}33`, paddingTop: 6 }}>
          Inclui saldo inicial de {b.saldoInicial > 0 ? "+" : ""}{hhmm(b.saldoInicial)} lançado na adesão ao sistema.
        </div>
      )}
    </Cartao>
  );
}

function RelogioPonto() {
  const [h, setH] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setH(new Date()), 1000); return () => clearInterval(t); }, []);
  return <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 30, color: C.navy, letterSpacing: 1 }}>{h.toLocaleTimeString("pt-BR")}</div>;
}

// Comprovante de registro — exigência da Portaria MTP 671/2021
function Comprovante({ m, perfil, func, fechar }) {
  const texto = [
    "COMPROVANTE DE REGISTRO DE PONTO",
    EMPREGADOR.razao, `CNPJ ${EMPREGADOR.cnpj}`,
    "",
    `Empregado: ${perfil.nome}`,
    func?.cpf ? `CPF: ${func.cpf}` : "",
    func?.matricula ? `Matrícula: ${func.matricula}` : "",
    `Data/hora: ${fmtBR(hojeISO())} ${m.hora}`,
    `Tipo: ${rotMarca(m.tipo)}`,
    `NSR: ${m.nsr}`,
    m.utm ? `Local (UTM): ${m.utm}` : "",
    `Origem: ${m.origem}`,
  ].filter(Boolean).join("\n");

  const compartilhar = async () => {
    try {
      if (navigator.share) await navigator.share({ title: "Comprovante de ponto", text: texto });
      else { await navigator.clipboard.writeText(texto); alert("Comprovante copiado."); }
    } catch { /* usuário cancelou */ }
  };

  return (
    <div onClick={fechar} style={{ position: "fixed", inset: 0, zIndex: 120, background: "rgba(8,12,32,.78)", display: "grid", placeItems: "center", padding: 18 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 18, padding: 20, width: "100%", maxWidth: 380, fontFamily: F.body }}>
        <div style={{ textAlign: "center", borderBottom: `2px dashed ${C.line}`, paddingBottom: 12, marginBottom: 12 }}>
          <Logo s={40} />
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 15, color: C.navy, marginTop: 8 }}>COMPROVANTE DE REGISTRO</div>
          <div style={{ fontSize: 10.5, color: C.mut, marginTop: 2 }}>{EMPREGADOR.razao} · CNPJ {EMPREGADOR.cnpj}</div>
        </div>
        <div style={{ textAlign: "center", margin: "6px 0 14px" }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 42, color: C.navy, lineHeight: 1 }}>{m.hora}</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.mut, marginTop: 4 }}>{rotMarca(m.tipo)} · {fmtBR(hojeISO())}</div>
        </div>
        <Linha k="Empregado" v={perfil.nome} />
        {func?.cpf && <Linha k="CPF" v={func.cpf} />}
        {func?.matricula && <Linha k="Matrícula" v={func.matricula} />}
        <Linha k="NSR" v={m.nsr} forte />
        {m.utm && <Linha k="Local (UTM)" v={m.utm} />}
        <div style={{ fontSize: 10.5, color: C.mut, marginTop: 10, lineHeight: 1.5 }}>
          Marcação gravada de forma definitiva: não pode ser alterada nem excluída.
          Guarde este comprovante — ele é seu direito (Portaria MTP 671/2021).
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <Btn tom="ok" onClick={compartilhar} style={{ flex: 1 }}>📤 Salvar / enviar</Btn>
          <Btn tom="claro" cheio={false} onClick={fechar} style={{ padding: "13px 20px" }}>Fechar</Btn>
        </div>
      </div>
    </div>
  );
}

// Espelho resumido do próprio funcionário
function MeuEspelho({ perfil, func, cfg, ym, setYm, mes }) {
  const { linhas, t } = useMemo(() => calcularMes({ ym, dias: mes, func, cfg }), [ym, mes, func, cfg]);
  const banco = useBancoHoras(perfil.uid, func, cfg, ym); // acumulado até o mês escolhido
  const posMes = t.saldo >= 0, posAcc = banco.saldoAcumulado >= 0;
  return (
    <>
      <Cartao>
        <Campo rotulo="Mês de referência" type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
        <Linha k="Dias com registro" v={`${t.diasComRegistro} de ${t.diasUteis} dia(s) úteis`} />
        <Linha k="Horas trabalhadas" v={hhmm(t.trabalhado)} forte />
        <Linha k="Jornada prevista" v={hhmm(t.previsto)} />
        <Linha k={`Extras dia útil (${cfg.ponto.pctNormal}%)`} v={hhmm(t.extraNormal)} forte />
        <Linha k={`Extras fim de semana/feriado (${cfg.ponto.pctFimSemana}%)`} v={hhmm(t.extraEspecial)} forte />
        {t.noturno > 0 && <Linha k={`Adicional noturno (${cfg.ponto.adicNoturno}%)`} v={hhmm(t.noturno)} />}
        {t.debito > 0 && <Linha k="Atrasos / saídas antecipadas" v={hhmm(t.debito)} />}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", fontSize: 14, borderBottom: `1px dashed ${C.line}` }}>
          <span style={{ color: C.mut }}>Saldo do mês</span>
          <span style={{ fontWeight: 800, color: posMes ? C.ok : C.red, textAlign: "right" }}>{posMes && t.saldo ? "+" : ""}{hhmm(t.saldo)}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", fontSize: 14 }}>
          <span style={{ color: C.mut }}>Banco de horas acumulado até {rotMes(ym)}</span>
          <span style={{ fontWeight: 800, color: banco.carregando ? C.mut : posAcc ? C.ok : C.red, textAlign: "right" }}>
            {banco.carregando ? "…" : `${posAcc && banco.saldoAcumulado ? "+" : ""}${hhmm(banco.saldoAcumulado)}`}
          </span>
        </div>
      </Cartao>
      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 8 }}>Dias com registro</div>
        {linhas.filter((l) => l.marcacoes.length).map((l) => {
          const pos = l.saldo >= 0;
          return (
            <div key={l.dataRef} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: `1px dashed ${C.line}`, fontSize: 13 }}>
              <span style={{ color: C.mut }}>{fmtBR(l.dataRef)} {DIA_ROT[l.chave]}</span>
              <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ fontWeight: 700 }}>{l.marcacoes.map((m) => m.hora).join(" · ")}</span>
                {l.prevista > 0 && l.saldo !== 0 && (
                  <span style={{ fontWeight: 800, fontSize: 11.5, color: pos ? C.ok : C.red, minWidth: 48, textAlign: "right" }}>{pos ? "+" : ""}{hhmm(l.saldo)}</span>
                )}
              </span>
            </div>
          );
        })}
        {!linhas.some((l) => l.marcacoes.length) && <div style={{ color: C.mut, fontSize: 13.5, textAlign: "center" }}>Sem marcações neste mês.</div>}
      </Cartao>
    </>
  );
}

// ============================================================================
// COORDENAÇÃO — Pessoal
// ============================================================================
export function CoordPessoal({ perfil }) {
  const [sub, setSub] = useState("alertas");
  const Seg = ({ id, rot }) => (
    <button onClick={() => setSub(id)} style={{
      flex: 1, border: "none", cursor: "pointer", padding: "9px 4px", borderRadius: 10,
      fontFamily: F.body, fontWeight: 700, fontSize: 12.5,
      background: sub === id ? C.navy : "transparent", color: sub === id ? "#fff" : C.mut,
    }}>{rot}</button>
  );
  return (
    <>
      <div style={{ display: "flex", gap: 4, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 12, padding: 4, marginBottom: 12 }}>
        <Seg id="alertas" rot="🔔 Alertas" />
        <Seg id="equipe" rot="🪪 Funcionários" />
        <Seg id="ponto" rot="🕐 Ponto" />
        <Seg id="cfg" rot="⚙️ Parâmetros" />
      </div>
      {sub === "alertas" && <PainelAlertas />}
      {sub === "equipe" && <CadastroFuncionarios perfil={perfil} />}
      {sub === "ponto" && <ApuracaoPonto perfil={perfil} />}
      {sub === "cfg" && <ParametrosPessoal perfil={perfil} />}
    </>
  );
}

// ----------------------------------------------------------------------------
// Painel de alertas — ASO · Ficha de EPI · férias · PCMSO · PGR
// ----------------------------------------------------------------------------
function PainelAlertas() {
  const funcs = useFuncionarios(true);
  const cfg = useConfigPessoal();
  if (!cfg) return null;

  const itens = [];
  funcs.forEach((f) => {
    const aso = situacaoValidade(f.docs?.aso?.validade);
    const epi = situacaoValidade(f.docs?.epi?.validade);
    const fer = situacaoFerias(f.admissao, f.ferias || []);
    if (aso.st === "vencido" || aso.st === "vencendo" || aso.st === "sem")
      itens.push({ nome: f.nome, tipo: "ASO", sit: aso, prio: aso.st === "vencido" ? 0 : aso.st === "sem" ? 2 : 1 });
    if (epi.st === "vencido" || epi.st === "vencendo" || epi.st === "sem")
      itens.push({ nome: f.nome, tipo: "Ficha de EPI", sit: epi, prio: epi.st === "vencido" ? 0 : epi.st === "sem" ? 2 : 1 });
    if (["dobra", "urgente", "atencao"].includes(fer.st))
      itens.push({ nome: f.nome, tipo: "Férias", sit: fer, prio: fer.st === "dobra" ? 0 : fer.st === "urgente" ? 1 : 1.5 });
  });
  itens.sort((a, b) => a.prio - b.prio || a.nome.localeCompare(b.nome));

  const pcmso = situacaoValidade(cfg.sst?.pcmso?.validade);
  const pgrs = (cfg.sst?.pgr || []).map((p) => ({ ...p, sit: situacaoValidade(p.validade) }));
  const criticos = itens.filter((i) => i.sit.st === "vencido" || i.sit.st === "dobra").length;

  return (
    <>
      <Titulo sub="Vencimentos de saúde e segurança do trabalho, férias e documentos da empresa.">Alertas</Titulo>

      <Cartao style={{ background: criticos ? C.redBg : C.okBg, borderColor: criticos ? C.red : "#BBE6C8" }}>
        <div style={{ fontWeight: 800, color: criticos ? C.red : C.ok, fontSize: 15 }}>
          {criticos ? `⚠️ ${criticos} pendência(s) vencida(s)` : "✅ Nenhum documento vencido"}
        </div>
        <div style={{ fontSize: 12.5, color: C.mut, marginTop: 3 }}>
          {funcs.length} funcionário(s) ativo(s) · {itens.length} item(ns) exigindo atenção
        </div>
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 8 }}>🏢 Documentos da empresa</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px dashed ${C.line}` }}>
          <span style={{ fontSize: 13.5 }}><b>PCMSO</b> {cfg.sst?.pcmso?.responsavel ? <span style={{ color: C.mut }}>· {cfg.sst.pcmso.responsavel}</span> : null}</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: pcmso.cor, background: pcmso.bg, padding: "3px 9px", borderRadius: 99 }}>{pcmso.rot}</span>
        </div>
        {pgrs.map((p, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px dashed ${C.line}` }}>
            <span style={{ fontSize: 13.5 }}><b>PGR</b> <span style={{ color: C.mut }}>· {p.estabelecimento || "estabelecimento"}</span></span>
            <span style={{ fontSize: 12, fontWeight: 800, color: p.sit.cor, background: p.sit.bg, padding: "3px 9px", borderRadius: 99 }}>{p.sit.rot}</span>
          </div>
        ))}
        {!pgrs.length && <div style={{ fontSize: 12.5, color: C.mut, marginTop: 6 }}>Nenhum PGR cadastrado. Cadastre em Parâmetros — o PGR é por estabelecimento/obra, não por funcionário.</div>}
      </Cartao>

      {!itens.length && <Cartao><div style={{ color: C.mut, textAlign: "center", padding: 8 }}>Nenhum vencimento de funcionário nos próximos 30 dias.</div></Cartao>}
      {itens.map((i, k) => (
        <Cartao key={k} style={{ borderColor: i.sit.st === "vencido" || i.sit.st === "dobra" ? C.red : C.line, background: i.sit.st === "vencido" || i.sit.st === "dobra" ? C.redBg : "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 800, color: C.navy, fontSize: 14.5 }}>{i.nome}</div>
              <div style={{ fontSize: 12.5, color: C.mut }}>{i.tipo}</div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 800, color: i.sit.cor, background: i.sit.bg, padding: "5px 11px", borderRadius: 99, textAlign: "right" }}>{i.sit.rot}</span>
          </div>
        </Cartao>
      ))}
    </>
  );
}

// ----------------------------------------------------------------------------
// Cadastro de funcionários
// ----------------------------------------------------------------------------
const PAPEIS = [
  { id: "funcionario", rot: "Somente cartão de ponto" },
  { id: "obra", rot: "Técnico de obra" },
  { id: "usina", rot: "Técnico de usina" },
  { id: "ambos", rot: "Técnico de usina + obra" },
  { id: "diretoria", rot: "Diretoria (somente visualizar)" },
  { id: "coordenador", rot: "Coordenador" },
];

function CadastroFuncionarios({ perfil }) {
  const funcs = useFuncionarios();
  const [novo, setNovo] = useState(false);
  const [abrir, setAbrir] = useState(null);
  return (
    <>
      <Titulo sub="Cada funcionário tem login próprio, jornada configurada e documentos com validade controlada.">Funcionários</Titulo>
      {novo ? <FormNovoFuncionario perfil={perfil} aoFechar={() => setNovo(false)} />
        : <Btn onClick={() => setNovo(true)} style={{ marginBottom: 12 }}>➕ Cadastrar funcionário</Btn>}

      {!funcs.length && <Cartao><div style={{ color: C.mut, textAlign: "center" }}>Nenhum funcionário cadastrado ainda.</div></Cartao>}
      {funcs.map((f) => {
        const aso = situacaoValidade(f.docs?.aso?.validade);
        const epi = situacaoValidade(f.docs?.epi?.validade);
        const fer = situacaoFerias(f.admissao, f.ferias || []);
        const pior = [aso, epi, fer].some((x) => x.st === "vencido" || x.st === "dobra");
        return (
          <Cartao key={f.uid} style={{ borderColor: pior ? C.red : C.line, opacity: f.ativo === false ? 0.6 : 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{f.nome}</div>
                <div style={{ fontSize: 12.5, color: C.mut }}>
                  {f.funcao || "função não informada"}{f.admissao ? ` · admitido em ${fmtBR(f.admissao)}` : ""}
                </div>
              </div>
              {f.pontoAtivo !== false && <span style={{ fontSize: 11, fontWeight: 800, color: C.blue, background: C.blueBg, padding: "3px 9px", borderRadius: 99, whiteSpace: "nowrap" }}>🕐 ponto</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 10 }}>
              {[["ASO", aso], ["EPI", epi], ["Férias", fer]].map(([rot, s]) => (
                <div key={rot} style={{ background: s.bg, borderRadius: 9, padding: "7px 8px", textAlign: "center" }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: C.mut }}>{rot}</div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: s.cor, marginTop: 2, lineHeight: 1.25 }}>{s.rot}</div>
                </div>
              ))}
            </div>
            <button onClick={() => setAbrir(abrir === f.uid ? null : f.uid)}
              style={{ background: "none", border: "none", color: C.blue, fontWeight: 700, fontSize: 13, marginTop: 10, cursor: "pointer", padding: 0 }}>
              {abrir === f.uid ? "▲ Fechar ficha" : "✏️ Abrir ficha completa"}
            </button>
            {abrir === f.uid && <FichaFuncionario f={f} perfil={perfil} />}
          </Cartao>
        );
      })}
    </>
  );
}

function FormNovoFuncionario({ perfil, aoFechar }) {
  const [f, setF] = useState({
    nome: "", email: "", senha: "", cpf: "", matricula: "", funcao: "",
    papel: "funcionario", pontoAtivo: true, admissao: hojeISO(), salario: "",
    aso: "", asoTipo: "Admissional", epi: "",
  });
  const [msg, setMsg] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const m = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const criar = async () => {
    setMsg("");
    if (!f.nome.trim() || !f.email.trim() || f.senha.length < 6) return setMsg("Nome, e-mail e senha (6+) são obrigatórios.");
    setOcupado(true);
    try {
      const sec = getApps().find((a) => a.name === "sec") || initializeApp(firebaseConfig, "sec");
      const sAuth = getAuth(sec);
      const cred = await createUserWithEmailAndPassword(sAuth, f.email.trim(), f.senha);
      const uid = cred.user.uid;
      await setDoc(doc(db, "usuarios", uid), {
        nome: f.nome.trim(), email: f.email.trim(), papel: f.papel,
        ponto: !!f.pontoAtivo, obraId: "", ativo: true,
        criadoEm: agoraISO(), criadoPor: perfil.nome,
      });
      await setDoc(doc(db, "funcionarios", uid), {
        nome: f.nome.trim(), email: f.email.trim(), cpf: f.cpf.trim(), matricula: f.matricula.trim(),
        funcao: f.funcao.trim(), admissao: f.admissao, demissao: "", salario: num(f.salario),
        pontoAtivo: !!f.pontoAtivo, regime: REGIME_PADRAO, nsr: 0, ferias: [], ativo: true,
        docs: {
          aso: { validade: f.aso, tipo: f.asoTipo, medico: "", obs: "" },
          epi: { validade: f.epi, obs: "" },
        },
        criadoEm: agoraISO(), criadoPor: perfil.nome,
      });
      await signOut(sAuth);
      setMsg("ok");
      setTimeout(aoFechar, 900);
    } catch (e) {
      setMsg(e.code === "auth/email-already-in-use"
        ? "E-mail já cadastrado. Se a pessoa já tem login, abra a ficha dela na lista abaixo."
        : "Falha ao criar. Verifique a internet.");
    }
    setOcupado(false);
  };

  return (
    <Cartao style={{ borderColor: C.navy }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontWeight: 800, color: C.navy }}>➕ Novo funcionário</div>
        <button onClick={aoFechar} style={{ border: "none", background: "none", color: C.mut, fontWeight: 800, cursor: "pointer" }}>✕</button>
      </div>
      <Campo rotulo="Nome completo *" value={f.nome} onChange={m("nome")} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Campo rotulo="E-mail (login) *" type="email" autoCapitalize="none" value={f.email} onChange={m("email")} />
        <Campo rotulo="Senha provisória *" value={f.senha} onChange={m("senha")} placeholder="6+ caracteres" />
        <Campo rotulo="CPF" value={f.cpf} onChange={m("cpf")} inputMode="numeric" placeholder="000.000.000-00" />
        <Campo rotulo="Matrícula" value={f.matricula} onChange={m("matricula")} />
        <Campo rotulo="Função / cargo" value={f.funcao} onChange={m("funcao")} placeholder="Ex.: Técnico de laboratório" />
        <Campo rotulo="Data de admissão *" type="date" value={f.admissao} onChange={m("admissao")} />
        <Sel rotulo="Acesso no sistema" value={f.papel} onChange={m("papel")}>
          {PAPEIS.map((p) => <option key={p.id} value={p.id}>{p.rot}</option>)}
        </Sel>
        <Sel rotulo="Bate ponto pelo app?" value={f.pontoAtivo ? "s" : "n"} onChange={(e) => setF({ ...f, pontoAtivo: e.target.value === "s" })}>
          <option value="s">Sim</option><option value="n">Não</option>
        </Sel>
        <Campo rotulo="Salário base (opcional)" sufixo="R$" inputMode="decimal" value={f.salario} onChange={m("salario")} placeholder="Só para conferência" />
      </div>

      <div style={{ fontWeight: 800, color: C.navy, fontSize: 14, margin: "10px 0 6px" }}>Saúde e segurança</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Sel rotulo="Tipo do ASO" value={f.asoTipo} onChange={m("asoTipo")}>
          {["Admissional", "Periódico", "Mudança de risco", "Retorno ao trabalho", "Demissional"].map((x) => <option key={x}>{x}</option>)}
        </Sel>
        <Campo rotulo="Validade do ASO" type="date" value={f.aso} onChange={m("aso")} />
        <Campo rotulo="Validade da Ficha de EPI" type="date" value={f.epi} onChange={m("epi")} />
      </div>
      <div style={{ fontSize: 12, color: C.mut, background: C.blueBg, borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>
        ℹ️ PCMSO e PGR não são cadastrados por funcionário: o PCMSO é da empresa e o PGR é por estabelecimento/obra.
        Ambos ficam em Pessoal › Parâmetros e alimentam o mesmo painel de alertas.
      </div>
      {msg === "ok" && <div style={{ color: C.ok, fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>✅ Funcionário cadastrado. Envie e-mail e senha a ele.</div>}
      {msg && msg !== "ok" && <div style={{ color: C.red, fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>{msg}</div>}
      <Btn onClick={criar} disabled={ocupado}>{ocupado ? "Cadastrando…" : "Cadastrar funcionário"}</Btn>
    </Cartao>
  );
}

function FichaFuncionario({ f, perfil }) {
  const [d, setD] = useState({
    cpf: f.cpf || "", matricula: f.matricula || "", funcao: f.funcao || "",
    admissao: f.admissao || "", demissao: f.demissao || "", salario: f.salario ?? "",
    aso: f.docs?.aso?.validade || "", asoTipo: f.docs?.aso?.tipo || "Periódico", asoMedico: f.docs?.aso?.medico || "",
    epi: f.docs?.epi?.validade || "", epiObs: f.docs?.epi?.obs || "",
    pontoAtivo: f.pontoAtivo !== false,
    saldoInicialH: f.saldoInicialMin != null ? (f.saldoInicialMin / 60).toString().replace(".", ",") : "",
    regime: { ...REGIME_PADRAO, ...(f.regime || {}) },
  });
  const [fe, setFe] = useState({ inicio: "", fim: "" });
  const [msg, setMsg] = useState("");
  const m = (k) => (e) => setD({ ...d, [k]: e.target.value });
  const md = (dia) => (e) => setD({ ...d, regime: { ...d.regime, dias: { ...d.regime.dias, [dia]: num(e.target.value) ?? 0 } } });

  const salvar = async () => {
    await updateDoc(doc(db, "funcionarios", f.uid), {
      cpf: d.cpf.trim(), matricula: d.matricula.trim(), funcao: d.funcao.trim(),
      admissao: d.admissao, demissao: d.demissao, salario: num(d.salario),
      pontoAtivo: d.pontoAtivo, regime: d.regime,
      saldoInicialMin: d.saldoInicialH === "" ? 0 : Math.round((num(d.saldoInicialH) || 0) * 60),
      docs: {
        aso: { validade: d.aso, tipo: d.asoTipo, medico: d.asoMedico, obs: "" },
        epi: { validade: d.epi, obs: d.epiObs },
      },
      ultimaEdicao: { por: perfil.nome, em: agoraISO() },
    }).catch(() => setMsg("Falha ao salvar."));
    updateDoc(doc(db, "usuarios", f.uid), { ponto: d.pontoAtivo }).catch(() => {});
    setMsg("ok"); setTimeout(() => setMsg(""), 2500);
  };

  const lancarFerias = async () => {
    if (!fe.inicio || !fe.fim) return alert("Informe início e fim das férias gozadas.");
    await updateDoc(doc(db, "funcionarios", f.uid), {
      ferias: arrayUnion({ inicio: fe.inicio, fim: fe.fim, dias: diasEntre(fe.inicio, fe.fim) + 1, lancadoPor: perfil.nome, em: agoraISO() }),
    });
    setFe({ inicio: "", fim: "" });
  };

  const fer = situacaoFerias(d.admissao, f.ferias || []);
  const semanal = Object.values(d.regime.dias || {}).reduce((s, v) => s + (v || 0), 0);

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Campo rotulo="CPF" value={d.cpf} onChange={m("cpf")} inputMode="numeric" />
        <Campo rotulo="Matrícula" value={d.matricula} onChange={m("matricula")} />
        <Campo rotulo="Função / cargo" value={d.funcao} onChange={m("funcao")} />
        <Campo rotulo="Salário base" sufixo="R$" inputMode="decimal" value={d.salario} onChange={m("salario")} />
        <Campo rotulo="Admissão" type="date" value={d.admissao} onChange={m("admissao")} />
        <Campo rotulo="Demissão (se houver)" type="date" value={d.demissao} onChange={m("demissao")} />
      </div>

      <div style={{ fontWeight: 800, color: C.navy, fontSize: 14, margin: "8px 0 6px" }}>Saúde e segurança</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Sel rotulo="Tipo do ASO" value={d.asoTipo} onChange={m("asoTipo")}>
          {["Admissional", "Periódico", "Mudança de risco", "Retorno ao trabalho", "Demissional"].map((x) => <option key={x}>{x}</option>)}
        </Sel>
        <Campo rotulo="Validade do ASO" type="date" value={d.aso} onChange={m("aso")} />
        <Campo rotulo="Médico examinador" value={d.asoMedico} onChange={m("asoMedico")} />
        <Campo rotulo="Validade da Ficha de EPI" type="date" value={d.epi} onChange={m("epi")} />
      </div>
      <Campo rotulo="Observações da Ficha de EPI" value={d.epiObs} onChange={m("epiObs")} placeholder="Ex.: bota, capacete, protetor auricular entregues em 10/03" />

      <div style={{ fontWeight: 800, color: C.navy, fontSize: 14, margin: "8px 0 6px" }}>
        Jornada contratual <span style={{ color: C.mut, fontWeight: 600, fontSize: 12.5 }}>· {hhmm(semanal)} por semana</span>
      </div>
      <div style={{ fontSize: 12, color: C.mut, marginBottom: 8 }}>
        Minutos previstos por dia. Dia com 0 não tem jornada prevista — todo trabalho nele entra como adicional de fim de semana.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 5, marginBottom: 10 }}>
        {["seg", "ter", "qua", "qui", "sex", "sab", "dom"].map((k) => (
          <span key={k}>
            <span style={{ display: "block", fontSize: 10.5, fontWeight: 700, color: C.mut, textAlign: "center", marginBottom: 3 }}>{DIA_ROT[k]}</span>
            <input value={d.regime.dias?.[k] ?? 0} onChange={md(k)} inputMode="numeric"
              style={{ width: "100%", boxSizing: "border-box", fontSize: 13, padding: "8px 4px", borderRadius: 8, border: `1.5px solid ${C.line}`, textAlign: "center", fontFamily: F.body }} />
          </span>
        ))}
      </div>
      <Sel rotulo="Bate ponto pelo app?" value={d.pontoAtivo ? "s" : "n"} onChange={(e) => setD({ ...d, pontoAtivo: e.target.value === "s" })}>
        <option value="s">Sim</option><option value="n">Não</option>
      </Sel>
      <Campo rotulo="Saldo inicial de banco de horas (opcional)" sufixo="h" inputMode="decimal"
        value={d.saldoInicialH} onChange={m("saldoInicialH")} placeholder="Ex.: 8 ou -4,5" />
      <div style={{ fontSize: 11.5, color: C.mut, marginTop: -6, marginBottom: 10 }}>
        Crédito/débito que o funcionário já tinha antes de começar a bater ponto aqui. Positivo = a favor dele; negativo = a compensar. Entra no banco de horas acumulado.
      </div>

      <div style={{ fontWeight: 800, color: C.navy, fontSize: 14, margin: "8px 0 6px" }}>Férias</div>
      <div style={{ background: fer.bg, borderRadius: 10, padding: "9px 12px", marginBottom: 10 }}>
        <div style={{ fontWeight: 800, color: fer.cor, fontSize: 13.5 }}>{fer.rot}</div>
        {fer.aquisitivoIni && <div style={{ fontSize: 12, color: C.mut, marginTop: 3 }}>
          Aquisitivo {fmtBR(fer.aquisitivoIni)} → {fmtBR(fer.aquisitivoFim)} · concessivo até {fmtBR(fer.concessivoFim)}
        </div>}
      </div>
      {(f.ferias || []).map((x, i) => (
        <Linha key={i} k={`Gozadas ${i + 1}`} v={`${fmtBR(x.inicio)} a ${fmtBR(x.fim)} · ${x.dias} dia(s)`} />
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 7, alignItems: "end", marginTop: 8 }}>
        <Campo rotulo="Início do gozo" type="date" value={fe.inicio} onChange={(e) => setFe({ ...fe, inicio: e.target.value })} style={{ marginBottom: 0 }} />
        <Campo rotulo="Fim do gozo" type="date" value={fe.fim} onChange={(e) => setFe({ ...fe, fim: e.target.value })} style={{ marginBottom: 0 }} />
        <Btn cheio={false} onClick={lancarFerias} style={{ padding: "12px 14px" }}>+</Btn>
      </div>

      {msg === "ok" && <div style={{ color: C.ok, fontWeight: 700, fontSize: 13.5, margin: "10px 0" }}>✅ Ficha salva.</div>}
      {msg && msg !== "ok" && <div style={{ color: C.red, fontWeight: 600, fontSize: 13.5, margin: "10px 0" }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Btn onClick={salvar} style={{ flex: 1 }}>💾 Salvar ficha</Btn>
        <Btn tom={f.ativo === false ? "ok" : "claro"} cheio={false} style={{ padding: "13px 16px", fontSize: 13 }}
          onClick={() => updateDoc(doc(db, "funcionarios", f.uid), { ativo: f.ativo === false })}>
          {f.ativo === false ? "Reativar" : "Desligar"}
        </Btn>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Apuração do ponto (coordenação)
// ----------------------------------------------------------------------------
function ApuracaoPonto({ perfil }) {
  const funcs = useFuncionarios();
  const cfg = useConfigPessoal();
  const [ym, setYm] = useState(mesRef());
  const [uid, setUid] = useState("");
  const [espelho, setEspelho] = useState(null);
  const [consolidado, setConsolidado] = useState(null);
  const [carregando, setCarregando] = useState("");
  const func = funcs.find((f) => f.uid === uid);
  const mes = usePontoMes(uid, ym);

  const resumo = useMemo(() => (uid && cfg ? calcularMes({ ym, dias: mes, func, cfg }) : null), [uid, ym, mes, func, cfg]);

  const consolidar = async () => {
    setCarregando("Consolidando o mês de toda a equipe…");
    try {
      const s = await getDocs(query(collection(db, "ponto"), where("dataRef", ">=", `${ym}-01`), where("dataRef", "<=", `${ym}-31`)));
      const porUid = {};
      s.docs.forEach((d) => { const x = d.data(); (porUid[x.uid] ||= {})[x.dataRef] = x; });
      const linhas = funcs.filter((f) => f.pontoAtivo !== false).map((f) => ({
        f, ...calcularMes({ ym, dias: porUid[f.uid] || {}, func: f, cfg }),
      }));
      setConsolidado({ ym, linhas });
    } catch { alert("Não foi possível consolidar. Verifique a internet."); }
    setCarregando("");
  };

  const exportarCSV = () => {
    if (!resumo || !func) return;
    const l = ["Data;Dia;Marcacoes (NSR:hora:tipo);Trabalhado;Previsto;Extra dia util;Extra fim de semana;Noturno;Debito;Avisos"];
    resumo.linhas.forEach((x) => l.push([
      fmtBR(x.dataRef), DIA_ROT[x.chave],
      x.marcacoes.map((m) => `${m.nsr}:${m.hora}:${m.tipo}`).join(" | "),
      hhmm(x.trabalhado), hhmm(x.prevista), hhmm(x.extraNormal), hhmm(x.extraEspecial), hhmm(x.noturno), hhmm(x.debito),
      x.avisos.join(" / "),
    ].join(";")));
    const blob = new Blob(["\uFEFF" + l.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ponto-${(func.nome || "func").replace(/\W+/g, "-").toLowerCase()}-${ym}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  };

  if (!cfg) return null;

  return (
    <>
      <Titulo sub="Espelho mensal por funcionário, conferência e exportação para a contabilidade.">Apuração do ponto</Titulo>
      <Cartao>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Campo rotulo="Mês de referência" type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
          <Sel rotulo="Funcionário" value={uid} onChange={(e) => setUid(e.target.value)}>
            <option value="">Selecione…</option>
            {funcs.map((f) => <option key={f.uid} value={f.uid}>{f.nome}</option>)}
          </Sel>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Btn onClick={() => (func ? setEspelho({ func, ym }) : alert("Selecione o funcionário."))}>📄 Espelho de ponto</Btn>
          <Btn tom="claro" onClick={exportarCSV} disabled={!resumo}>⬇️ Exportar CSV</Btn>
        </div>
        <div style={{ height: 8 }} />
        <Btn tom="red" onClick={consolidar} disabled={!!carregando}>{carregando || "📊 Consolidar o mês de toda a equipe"}</Btn>
      </Cartao>

      {resumo && func && (
        <Cartao>
          <div style={{ fontWeight: 800, color: C.navy, marginBottom: 8 }}>{func.nome} · {rotMes(ym)}</div>
          <Linha k="Horas trabalhadas" v={hhmm(resumo.t.trabalhado)} forte />
          <Linha k="Jornada prevista" v={hhmm(resumo.t.previsto)} />
          <Linha k={`Extras em dia útil (${cfg.ponto.pctNormal}%)`} v={hhmm(resumo.t.extraNormal)} forte />
          <Linha k={`Extras fim de semana/feriado (${cfg.ponto.pctFimSemana}%)`} v={hhmm(resumo.t.extraEspecial)} forte />
          <Linha k={`Adicional noturno (${cfg.ponto.adicNoturno}%)`} v={hhmm(resumo.t.noturno)} />
          <Linha k="Atrasos / saídas antecipadas" v={hhmm(resumo.t.debito)} />
          <Linha k="Faltas em dia útil" v={resumo.t.faltas} />
          <Linha k="Reflexo do DSR sobre extras (Súm. 172)" v={hhmm(resumo.t.dsr)} />
          <BancoLinhaCoord uid={uid} func={func} cfg={cfg} ym={ym} />
          {resumo.t.vlTotal != null && <Linha k="Estimativa de adicionais (conferência)" v={brl(resumo.t.vlTotal)} forte />}
          {resumo.t.avisos > 0 && (
            <div style={{ background: C.warnBg, color: C.amber, fontSize: 12.5, fontWeight: 700, borderRadius: 9, padding: "8px 12px", marginTop: 10 }}>
              ⚠️ {resumo.t.avisos} dia(s) com inconsistência — confira no espelho antes de fechar o mês.
            </div>
          )}
        </Cartao>
      )}

      {consolidado && (
        <Cartao>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 800, color: C.navy }}>Equipe · {rotMes(consolidado.ym)}</div>
            <button onClick={() => setConsolidado(null)} style={{ border: "none", background: "none", color: C.mut, fontWeight: 800, cursor: "pointer" }}>✕</button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 520 }}>
              <thead><tr style={{ color: C.mut, textAlign: "left" }}>
                <th style={{ padding: 5 }}>Funcionário</th><th>Trabalhado</th><th>{cfg.ponto.pctNormal}%</th><th>{cfg.ponto.pctFimSemana}%</th><th>Faltas</th><th>Avisos</th>
              </tr></thead>
              <tbody>{consolidado.linhas.map(({ f, t }) => (
                <tr key={f.uid} style={{ borderTop: `1px solid ${C.line}` }}>
                  <td style={{ padding: 5, fontWeight: 700 }}>{f.nome}</td>
                  <td>{hhmm(t.trabalhado)}</td>
                  <td style={{ fontWeight: 700 }}>{hhmm(t.extraNormal)}</td>
                  <td style={{ fontWeight: 700, color: t.extraEspecial ? C.red : C.ink }}>{hhmm(t.extraEspecial)}</td>
                  <td style={{ color: t.faltas ? C.red : C.ink }}>{t.faltas || "—"}</td>
                  <td style={{ color: t.avisos ? C.amber : C.ink }}>{t.avisos || "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Cartao>
      )}

      {espelho && <EspelhoPonto {...espelho} cfg={cfg} perfil={perfil} fechar={() => setEspelho(null)} />}
    </>
  );
}

// Linha de banco de horas acumulado para a coordenação (mesmo número do funcionário)
function BancoLinhaCoord({ uid, func, cfg, ym }) {
  const b = useBancoHoras(uid, func, cfg, ym);
  const pos = b.saldoAcumulado >= 0;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", fontSize: 14, borderBottom: `1px dashed ${C.line}` }}>
      <span style={{ color: C.mut }}>Banco de horas acumulado</span>
      <span style={{ fontWeight: 800, color: b.carregando ? C.mut : pos ? C.ok : C.red, textAlign: "right" }}>
        {b.carregando ? "…" : `${pos && b.saldoAcumulado ? "+" : ""}${hhmm(b.saldoAcumulado)}`}
      </span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Espelho de ponto mensal (impressão / PDF)
// ----------------------------------------------------------------------------
function EspelhoPonto({ func, ym, cfg, perfil, fechar }) {
  const mes = usePontoMes(func.uid, ym);
  const { linhas, t } = useMemo(() => calcularMes({ ym, dias: mes, func, cfg }), [ym, mes, func, cfg]);
  const banco = useBancoHoras(func.uid, func, cfg, ym);
  const numero = `EP-${ym.replace("-", "")}-${(func.nome || "F").replace(/\W+/g, "").slice(0, 5).toUpperCase()}`;
  const aso = situacaoValidade(func.docs?.aso?.validade);
  const fer = situacaoFerias(func.admissao, func.ferias || []);

  return (
    <Impressao fechar={fechar} nomeArquivo={`${numero}.pdf`}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: `3px solid ${C.navy}`, paddingBottom: 10 }}>
        <Logo s={46} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 22, color: C.navy }}>SOLOCONTROL</div>
          <div style={{ fontSize: 10.5, color: C.mut }}>{EMPREGADOR.razao} · CNPJ {EMPREGADOR.cnpj}</div>
          <div style={{ fontSize: 10, color: C.mut }}>{EMPREGADOR.endereco}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 15, color: C.red }}>ESPELHO DE PONTO</div>
          <div style={{ fontSize: 11.5, fontWeight: 700 }}>{numero}</div>
          <div style={{ fontSize: 11.5, color: C.mut }}>{rotMes(ym)}</div>
        </div>
      </div>

      <div style={secRel}>Identificação do empregado</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        <tr>
          <td style={tabTd}><b>Nome:</b> {func.nome}</td>
          <td style={tabTd}><b>CPF:</b> {func.cpf || "—"}</td>
          <td style={tabTd}><b>Matrícula:</b> {func.matricula || "—"}</td>
        </tr>
        <tr>
          <td style={tabTd}><b>Função:</b> {func.funcao || "—"}</td>
          <td style={tabTd}><b>Admissão:</b> {func.admissao ? fmtBR(func.admissao) : "—"}</td>
          <td style={tabTd}><b>Jornada semanal:</b> {hhmm(Object.values(func.regime?.dias || REGIME_PADRAO.dias).reduce((s, v) => s + (v || 0), 0))}</td>
        </tr>
        <tr>
          <td style={tabTd}><b>ASO:</b> {aso.rot}</td>
          <td style={tabTd} colSpan={2}><b>Férias:</b> {fer.rot}</td>
        </tr>
      </tbody></table>

      <div style={secRel}>Marcações do período</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{["Data", "Dia", "Entrada", "Saída almoço", "Volta almoço", "Saída", "Trabalhado", "Previsto", `Extra ${cfg.ponto.pctNormal}%`, `Extra ${cfg.ponto.pctFimSemana}%`, "Débito", "Ocorrência"].map((h) => <th key={h} style={tabTh}>{h}</th>)}</tr></thead>
        <tbody>{linhas.map((l) => {
          const marcas = [0, 1, 2, 3].map((i) => l.marcacoes[i]?.hora || "");
          const descanso = l.prevista === 0;
          return (
            <tr key={l.dataRef} style={descanso ? { background: "#F7F9FC" } : null}>
              <td style={tabTd}>{fmtBR(l.dataRef).slice(0, 5)}</td>
              <td style={{ ...tabTd, color: descanso ? C.mut : C.ink, fontWeight: 700 }}>{DIA_ROT[l.chave]}</td>
              {marcas.map((h, i) => <td key={i} style={tabTd}>{h || "—"}</td>)}
              <td style={{ ...tabTd, fontWeight: 700 }}>{l.trabalhado ? hhmm(l.trabalhado) : "—"}</td>
              <td style={tabTd}>{l.prevista ? hhmm(l.prevista) : "—"}</td>
              <td style={{ ...tabTd, fontWeight: 800, color: l.extraNormal ? C.navy : C.mut }}>{l.extraNormal ? hhmm(l.extraNormal) : "—"}</td>
              <td style={{ ...tabTd, fontWeight: 800, color: l.extraEspecial ? C.red : C.mut }}>{l.extraEspecial ? hhmm(l.extraEspecial) : "—"}</td>
              <td style={{ ...tabTd, color: l.debito ? C.red : C.mut }}>{l.debito ? hhmm(l.debito) : "—"}</td>
              <td style={{ ...tabTd, fontSize: 9.5, color: C.amber }}>{l.feriado ? "Feriado. " : ""}{l.afastamento || ""}{l.avisos[0] || ""}</td>
            </tr>
          );
        })}</tbody>
      </table>

      <div style={secRel}>Totais do mês</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        <tr>
          <td style={tabTd}><b>Horas trabalhadas:</b> {hhmm(t.trabalhado)}</td>
          <td style={tabTd}><b>Jornada prevista:</b> {hhmm(t.previsto)}</td>
          <td style={tabTd}><b>Saldo:</b> {hhmm(t.saldo)}</td>
          <td style={tabTd}><b>Faltas:</b> {t.faltas}</td>
        </tr>
        <tr>
          <td style={tabTd}><b>Extras dia útil ({cfg.ponto.pctNormal}%):</b> {hhmm(t.extraNormal)}</td>
          <td style={tabTd}><b>Extras fim de semana/feriado ({cfg.ponto.pctFimSemana}%):</b> {hhmm(t.extraEspecial)}</td>
          <td style={tabTd}><b>Adicional noturno ({cfg.ponto.adicNoturno}%):</b> {hhmm(t.noturno)}</td>
          <td style={tabTd}><b>Atrasos:</b> {hhmm(t.debito)}</td>
        </tr>
        <tr>
          <td style={tabTd} colSpan={2}><b>Reflexo do DSR sobre horas extras (Súmula 172 do TST):</b> {hhmm(t.dsr)}</td>
          <td style={tabTd} colSpan={2}>{t.vlTotal != null ? <><b>Estimativa de adicionais:</b> {brl(t.vlTotal)} <span style={{ color: C.mut }}>(conferência)</span></> : "—"}</td>
        </tr>
        <tr>
          <td style={tabTd} colSpan={4}><b>Banco de horas acumulado até {rotMes(ym)}:</b> {banco.carregando ? "…" : `${banco.saldoAcumulado >= 0 && banco.saldoAcumulado ? "+" : ""}${hhmm(banco.saldoAcumulado)}`} {banco.saldoInicial ? <span style={{ color: C.mut }}>(inclui saldo inicial de {banco.saldoInicial > 0 ? "+" : ""}{hhmm(banco.saldoInicial)})</span> : null}</td>
        </tr>
      </tbody></table>

      <div style={{ fontSize: 10, color: C.mut, marginTop: 8, lineHeight: 1.5 }}>
        Critério de apuração: tolerância de {cfg.ponto.toleranciaMarcacaoMin} min por marcação, limitada a {cfg.ponto.toleranciaDiaMin} min diários
        (CLT art. 58, §1º). {cfg.ponto.modoTolerancia === "sumula366"
          ? "Ultrapassado o limite, computa-se a totalidade do tempo excedente à jornada, conforme a Súmula 366 do TST."
          : "ATENÇÃO: parametrizado para descontar a tolerância do tempo excedente — critério divergente da Súmula 366 do TST."}
        {" "}Adicionais aplicados: {cfg.ponto.pctNormal}% em dia útil e {cfg.ponto.pctFimSemana}% em dia sem jornada prevista.
        {cfg.ponto.cct?.sindicato ? ` Base normativa: ${cfg.ponto.cct.sindicato}${cfg.ponto.cct.mediador ? ` — registro Mediador/MTE ${cfg.ponto.cct.mediador}` : ""}${cfg.ponto.cct.vigencia ? ` (vigência ${cfg.ponto.cct.vigencia})` : ""}.` : " Convenção coletiva ainda não cadastrada nos parâmetros do sistema."}
        {" "}Valores monetários, quando exibidos, são estimativa para conferência — a folha de pagamento é elaborada pelo escritório contábil.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 30, marginTop: 44, breakInside: "avoid" }}>
        {[`${func.nome} — empregado`, "Solocontrol — coordenação"].map((r) => (
          <div key={r} style={{ textAlign: "center" }}><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 5, fontSize: 11 }}>{r}</div></div>
        ))}
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Documento gerado pelo sistema Solocontrol em {fmtDataHora()} · Nº {numero} · Emitido por {perfil?.nome || "—"}.
        Marcações gravadas de forma definitiva (append-only), com NSR sequencial por empregado e comprovante entregue no ato do registro.
      </div>
    </Impressao>
  );
}

// ----------------------------------------------------------------------------
// Parâmetros (coordenação)
// ----------------------------------------------------------------------------
function ParametrosPessoal({ perfil }) {
  const cfg = useConfigPessoal();
  const [d, setD] = useState(null);
  const [novoFer, setNovoFer] = useState({ data: "", nome: "" });
  const [novoPgr, setNovoPgr] = useState({ estabelecimento: "", validade: "" });
  const [msg, setMsg] = useState("");
  useEffect(() => { if (cfg && !d) setD(JSON.parse(JSON.stringify(cfg))); }, [cfg]);
  if (!d) return null;

  const mp = (k) => (e) => setD({ ...d, ponto: { ...d.ponto, [k]: num(e.target.value) ?? e.target.value } });
  const salvar = async () => {
    await setDoc(doc(db, "empresa", "config"), { ...d, ultimaEdicao: { por: perfil.nome, em: agoraISO() } }, { merge: true })
      .catch(() => setMsg("Falha ao salvar."));
    setMsg("ok"); setTimeout(() => setMsg(""), 2500);
  };

  return (
    <>
      <Titulo sub="Regras de cálculo do ponto, feriados e documentos da empresa.">Parâmetros</Titulo>

      <Cartao style={{ background: C.warnBg, borderColor: "#F3DDB5" }}>
        <div style={{ fontWeight: 800, color: C.amber, fontSize: 13.5, marginBottom: 4 }}>⚖️ Antes de usar em folha</div>
        <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.55 }}>
          Os percentuais abaixo vêm da convenção coletiva da categoria. O mínimo legal é 50% (CLT art. 7º, XVI)
          e 100% em domingo/feriado sem folga compensatória (Súmula 146 do TST). Cadastre o sindicato e o número
          de registro da CCT no Mediador/MTE — esses dados aparecem no rodapé de cada espelho de ponto emitido.
        </div>
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 10 }}>Convenção coletiva vigente</div>
        <Campo rotulo="Sindicato profissional" value={d.ponto.cct?.sindicato || ""}
          onChange={(e) => setD({ ...d, ponto: { ...d.ponto, cct: { ...d.ponto.cct, sindicato: e.target.value } } })}
          placeholder="Ex.: SEAAC Araraquara e Região" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Campo rotulo="Nº no Mediador/MTE" value={d.ponto.cct?.mediador || ""}
            onChange={(e) => setD({ ...d, ponto: { ...d.ponto, cct: { ...d.ponto.cct, mediador: e.target.value } } })} />
          <Campo rotulo="Vigência" value={d.ponto.cct?.vigencia || ""}
            onChange={(e) => setD({ ...d, ponto: { ...d.ponto, cct: { ...d.ponto.cct, vigencia: e.target.value } } })}
            placeholder="01/05/2026 a 30/04/2027" />
        </div>
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 10 }}>Cálculo de horas extras</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Campo rotulo="Adicional em dia útil" sufixo="%" inputMode="decimal" value={d.ponto.pctNormal} onChange={mp("pctNormal")} />
          <Campo rotulo="Adicional em fim de semana" sufixo="%" inputMode="decimal" value={d.ponto.pctFimSemana} onChange={mp("pctFimSemana")} />
          <Campo rotulo="Adicional em feriado" sufixo="%" inputMode="decimal" value={d.ponto.pctFeriado} onChange={mp("pctFeriado")} />
          <Campo rotulo="Adicional noturno" sufixo="%" inputMode="decimal" value={d.ponto.adicNoturno} onChange={mp("adicNoturno")} />
          <Campo rotulo="Tolerância por marcação" sufixo="min" inputMode="numeric" value={d.ponto.toleranciaMarcacaoMin} onChange={mp("toleranciaMarcacaoMin")} />
          <Campo rotulo="Tolerância no dia" sufixo="min" inputMode="numeric" value={d.ponto.toleranciaDiaMin} onChange={mp("toleranciaDiaMin")} />
          <Campo rotulo="Divisor mensal (valor-hora)" inputMode="numeric" value={d.ponto.horasMes} onChange={mp("horasMes")} />
          <Campo rotulo="Intervalo mínimo" sufixo="min" inputMode="numeric" value={d.ponto.intervaloMinimoMin} onChange={mp("intervaloMinimoMin")} />
        </div>
        <Sel rotulo="Como tratar o tempo que ultrapassa a tolerância" value={d.ponto.modoTolerancia}
          onChange={(e) => setD({ ...d, ponto: { ...d.ponto, modoTolerancia: e.target.value } })}>
          <option value="sumula366">Computar a totalidade do excedente (Súmula 366 do TST) — recomendado</option>
          <option value="excedente">Descontar a tolerância do excedente — só com respaldo da CCT</option>
        </Sel>
        {d.ponto.modoTolerancia === "excedente" && (
          <div style={{ background: C.redBg, color: C.red, fontSize: 12.5, fontWeight: 600, borderRadius: 10, padding: "9px 12px", marginBottom: 10 }}>
            ⚠️ Este modo contraria a Súmula 366 do TST: ultrapassados os {d.ponto.toleranciaDiaMin} min, o entendimento
            consolidado manda pagar todo o tempo excedente à jornada, e não só a diferença. Usar sem respaldo em CCT
            gera diferenças de horas extras em eventual reclamatória.
          </div>
        )}
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 10 }}>🏥 PCMSO (documento da empresa)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Campo rotulo="Validade" type="date" value={d.sst?.pcmso?.validade || ""}
            onChange={(e) => setD({ ...d, sst: { ...d.sst, pcmso: { ...d.sst.pcmso, validade: e.target.value } } })} />
          <Campo rotulo="Médico coordenador" value={d.sst?.pcmso?.responsavel || ""}
            onChange={(e) => setD({ ...d, sst: { ...d.sst, pcmso: { ...d.sst.pcmso, responsavel: e.target.value } } })} />
        </div>
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 4 }}>📋 PGR por estabelecimento</div>
        <div style={{ fontSize: 12.5, color: C.mut, marginBottom: 10 }}>Um PGR por estabelecimento/obra — não por funcionário.</div>
        {(d.sst?.pgr || []).map((p, i) => {
          const s = situacaoValidade(p.validade);
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: `1px dashed ${C.line}`, fontSize: 13.5 }}>
              <span><b>{p.estabelecimento}</b></span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11.5, fontWeight: 800, color: s.cor }}>{s.rot}</span>
                <button onClick={() => setD({ ...d, sst: { ...d.sst, pgr: d.sst.pgr.filter((_, j) => j !== i) } })}
                  style={{ border: "none", background: C.grayBg, color: C.red, borderRadius: 8, width: 28, height: 28, fontWeight: 800, cursor: "pointer" }}>×</button>
              </span>
            </div>
          );
        })}
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr auto", gap: 7, alignItems: "end", marginTop: 10 }}>
          <Campo rotulo="Estabelecimento / obra" value={novoPgr.estabelecimento} onChange={(e) => setNovoPgr({ ...novoPgr, estabelecimento: e.target.value })} style={{ marginBottom: 0 }} />
          <Campo rotulo="Validade" type="date" value={novoPgr.validade} onChange={(e) => setNovoPgr({ ...novoPgr, validade: e.target.value })} style={{ marginBottom: 0 }} />
          <Btn cheio={false} style={{ padding: "12px 14px" }}
            onClick={() => { if (!novoPgr.estabelecimento.trim()) return; setD({ ...d, sst: { ...d.sst, pgr: [...(d.sst.pgr || []), novoPgr] } }); setNovoPgr({ estabelecimento: "", validade: "" }); }}>+</Btn>
        </div>
      </Cartao>

      <Cartao>
        <div style={{ fontWeight: 800, color: C.navy, marginBottom: 4 }}>📅 Feriados</div>
        <div style={{ fontSize: 12.5, color: C.mut, marginBottom: 10 }}>Dias marcados aqui não têm jornada prevista — o trabalho neles entra no adicional de feriado.</div>
        {(d.feriados || []).sort((a, b) => a.data.localeCompare(b.data)).map((x, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: `1px dashed ${C.line}`, fontSize: 13.5 }}>
            <span><b>{fmtBR(x.data)}</b> <span style={{ color: C.mut }}>· {x.nome}</span></span>
            <button onClick={() => setD({ ...d, feriados: d.feriados.filter((_, j) => j !== i) })}
              style={{ border: "none", background: C.grayBg, color: C.red, borderRadius: 8, width: 28, height: 28, fontWeight: 800, cursor: "pointer" }}>×</button>
          </div>
        ))}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr auto", gap: 7, alignItems: "end", marginTop: 10 }}>
          <Campo rotulo="Data" type="date" value={novoFer.data} onChange={(e) => setNovoFer({ ...novoFer, data: e.target.value })} style={{ marginBottom: 0 }} />
          <Campo rotulo="Nome do feriado" value={novoFer.nome} onChange={(e) => setNovoFer({ ...novoFer, nome: e.target.value })} style={{ marginBottom: 0 }} />
          <Btn cheio={false} style={{ padding: "12px 14px" }}
            onClick={() => { if (!novoFer.data) return; setD({ ...d, feriados: [...(d.feriados || []), novoFer] }); setNovoFer({ data: "", nome: "" }); }}>+</Btn>
        </div>
      </Cartao>

      {msg === "ok" && <div style={{ color: C.ok, fontWeight: 700, fontSize: 14, marginBottom: 8, textAlign: "center" }}>✅ Parâmetros salvos.</div>}
      {msg && msg !== "ok" && <div style={{ color: C.red, fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>{msg}</div>}
      <Btn onClick={salvar}>💾 Salvar parâmetros</Btn>
    </>
  );
}

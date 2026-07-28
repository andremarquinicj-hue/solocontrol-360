// ============================================================================
// SOLOCONTROL 360 · MÓDULO CAP
// Recebimento de Cimento Asfáltico de Petróleo (CAP) na usina.
// Técnico de usina acompanha a carreta, fotografa no padrão georreferenciado,
// e ao finalizar o sistema gera o Relatório de Acompanhamento de Descarregamento
// (RAD) + a etiqueta da amostra (AM-CAP), numerados sequencialmente por ano.
// ----------------------------------------------------------------------------
// Autossuficiente: reaproveita só o kit visual/PDF do Pessoal.jsx; o pipeline
// de fotos com marca d'água é embutido aqui (mesmo padrão das cargas de massa).
//
// CÁLCULOS (constantes editáveis em CAP › topo do formulário):
//  - densidade a 25 °C (padrão 1,030 g/cm³ p/ CAP 30/45 — confirmar em ensaio)
//  - coeficiente de expansão térmica (padrão 0,00061 /°C)
//  - densidade corrigida à temperatura de recebimento
//  - fator de correção volumétrica = 1 / [1 + coef × (T − 25)]
//  - volume na temperatura e a 25 °C, ocupação do tanque
//  - taxa de transferência (kg/min, t/h) e vazão volumétrica (L/min, m³/h)
//  - potencial de produção de CBUQ por teor de ligante
//  - perda térmica expedição → recebimento (quando a NF traz a temperatura)
//  - comparação automática com as remessas anteriores da mesma obra
// Todos os resultados marcados como estimativa; o laudo é do laboratório.
// ============================================================================
import React, { useState, useEffect, useMemo, useRef } from "react";
import { db, storage } from "./firebase";
import {
  collection, doc, setDoc, updateDoc, onSnapshot,
  query, where, getDocs, arrayUnion,
} from "firebase/firestore";
import { ref as sRef, uploadString, uploadBytes, getDownloadURL } from "firebase/storage";
import {
  C, F, Btn, Campo, Sel, Cartao, Titulo, Linha, Logo, Impressao,
  secRel, tabTh, tabTd, hojeISO, agoraHM, agoraISO, fmtBR, fmtDataHora, num, pegarGPS,
} from "./Pessoal.jsx";

const rid = () => Math.random().toString(36).slice(2, 10);

// ----------------------------------------------------------------------------
// Parâmetros técnicos padrão do CAP 30/45 — TODOS editáveis no formulário.
// ----------------------------------------------------------------------------
const CAP_PADRAO = {
  densidade25: 1.030,       // g/cm³ a 25 °C (valor típico CAP 30/45)
  coefExpansao: 0.00061,    // /°C
  tempoRef: 25,             // °C — temperatura de referência do estoque
  capacidadeTanque: 30000,  // L — capacidade grafada no costado do tanque
  teorMin: 4.6,             // % — faixa de teor de projeto p/ potencial de CBUQ
  teorMax: 4.8,             // %
  tetoArmazenagem: 177,     // °C — teto usual de armazenagem
  bombeioMin: 140,          // °C — mínimo usual para bombeio
  pontoFulgorMin: 235,      // °C — ponto de fulgor mínimo especificado
};

// ----------------------------------------------------------------------------
// Foto: compressão + marca d'água (data/hora, UTM, obra, SOLOCONTROL).
// Mesmo padrão das cargas de massa. Embutido para o módulo ser autossuficiente.
// ----------------------------------------------------------------------------
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
function dataExtenso() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0"), ss = String(d.getSeconds()).padStart(2, "0");
  return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()} às ${hh}:${mm}:${ss}`;
}
async function prepararFoto(file, obraNome) {
  const utm = await pegarGPS();
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
  const base = Math.min(w, h);
  const linhas = [dataExtenso(), utm || "GPS indisponível", obraNome ? `#${obraNome.toUpperCase()}` : "SOLOCONTROL · CAP"];
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
    ctx.strokeText(l, w - mg, y);
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#fff";
    ctx.fillText(l, w - mg, y);
    ctx.restore();
  });
  return { id: rid(), b64: cv.toDataURL("image/jpeg", 0.82), utm: utm || "", hora: agoraHM() };
}
async function subirStorage(b64, path) {
  const r = sRef(storage, path);
  await uploadString(r, b64, "data_url");
  return await getDownloadURL(r);
}
async function anexarFoto(docPath, campo, foto, legenda = "") {
  const path = `fotos/${docPath.replace(/\//g, "_")}/${foto.id}.jpg`;
  const item = { id: foto.id, url: null, hora: foto.hora, utm: foto.utm, legenda };
  try {
    item.url = await subirStorage(foto.b64, path);
    await updateDoc(doc(db, docPath), { [campo]: arrayUnion(item) });
  } catch {
    updateDoc(doc(db, docPath), { [campo]: arrayUnion(item) }).catch(() => {});
  }
  return item;
}

function BotaoFoto({ obraNome, aoLocal, rotulo = "📷 Câmera" }) {
  const refCam = useRef(null);
  const refGal = useRef(null);
  const [ocupado, setOcupado] = useState(false);
  const processar = async (files) => {
    if (!files?.length) return;
    setOcupado(true);
    try {
      for (const file of files) {
        const foto = await prepararFoto(file, obraNome);
        aoLocal && aoLocal(foto);
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

const Miniaturas = ({ fotos = [], aoRemover }) => {
  if (!fotos.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
      {fotos.map((f, i) => (
        <div key={f.id} style={{ position: "relative" }}>
          <img src={f.url || f.b64} alt="" style={{ width: 74, height: 74, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.line}` }} />
          {aoRemover && <button onClick={() => aoRemover(i)} style={{ position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 99, border: "none", background: C.red, color: "#fff", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>×</button>}
        </div>
      ))}
    </div>
  );
};

// ----------------------------------------------------------------------------
// Utilidades de tempo
// ----------------------------------------------------------------------------
const minutosEntre = (h1, h2) => {
  if (!h1 || !h2) return null;
  const [a, b] = h1.split(":").map(Number), [c, d] = h2.split(":").map(Number);
  let m = c * 60 + d - (a * 60 + b);
  if (m < 0) m += 24 * 60;
  return m;
};
const fmtMin = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`);
const fmt = (v, casas = 2) => (v == null || isNaN(v) ? "—" : v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas }));
const anoDe = (iso) => iso.slice(0, 4);

// ----------------------------------------------------------------------------
// NÚCLEO DE CÁLCULO — todas as relações do modelo RAD
// ----------------------------------------------------------------------------
export function calcularCAP(r, cfg = CAP_PADRAO) {
  const p = { ...CAP_PADRAO, ...cfg };
  const massaT = num(r.pesoNota);              // t (peso líquido da NF)
  const tempReceb = num(r.tempRecebimento);    // °C
  const tempExped = num(r.tempExpedicao);      // °C (opcional, da NF)
  const dur = minutosEntre(r.inicio, r.fim);   // min de descarregamento
  const permanencia = minutosEntre(r.chegada, r.fim);
  const out = { avisos: [] };

  // 1 · Massa, densidade e correção térmica
  if (massaT != null && tempReceb != null) {
    const dT = tempReceb - p.tempoRef;
    const fator = 1 / (1 + p.coefExpansao * dT);            // 25 °C → temp receb
    const densCorr = p.densidade25 * fator;                 // g/cm³ na temp receb
    const massaKg = massaT * 1000;
    const volReceb = massaKg / densCorr;                    // L na temperatura
    const volRef = massaKg / p.densidade25;                 // L a 25 °C
    const ocup = (volReceb / p.capacidadeTanque) * 100;
    Object.assign(out, {
      dT, fator, densCorr, massaKg, volReceb, volRef, ocup,
    });
    if (ocup > 100) out.avisos.push(`Volume na temperatura de recebimento supera em ${fmt(ocup - 100, 1)}% a capacidade grafada de ${p.capacidadeTanque.toLocaleString("pt-BR")} L. Verificar densidade real do lote (laudo) e capacidade certificada do tanque.`);
  }

  // 2 · Taxa de transferência
  if (massaT != null && dur) {
    const kgMin = (massaT * 1000) / dur;
    const tH = (massaT / dur) * 60;
    out.kgMin = kgMin; out.tH = tH; out.dur = dur;
    if (out.densCorr) {
      out.lMin = kgMin / out.densCorr;                       // vazão volumétrica
      out.m3H = (out.lMin * 60) / 1000;
    }
  }
  out.permanencia = permanencia;

  // 3 · Potencial de produção de CBUQ (massa de CAP ÷ teor)
  if (massaT != null) {
    out.cbuqMax = (massaT / (p.teorMin / 100));  // menor teor → mais massa
    out.cbuqMin = (massaT / (p.teorMax / 100));  // maior teor → menos massa
    out.teorMin = p.teorMin; out.teorMax = p.teorMax;
  }

  // 4 · Perda térmica (só quando a NF traz a temperatura de expedição)
  if (tempExped != null && tempReceb != null) {
    out.perdaTermica = tempExped - tempReceb;
    if (permanencia && permanencia > 0) out.perdaHora = (out.perdaTermica / permanencia) * 60;
  } else {
    out.avisos.push("NF não informou a temperatura de expedição — não é possível calcular a perda térmica no trajeto.");
  }

  // 5 · Situação térmica do recebimento
  if (tempReceb != null) {
    out.tempOk = tempReceb >= p.bombeioMin && tempReceb <= p.tetoArmazenagem;
    out.margemTeto = p.tetoArmazenagem - tempReceb;
    out.margemFulgor = p.pontoFulgorMin - tempReceb;
    if (tempReceb > p.tetoArmazenagem) out.avisos.push(`Temperatura de recebimento (${tempReceb} °C) acima do teto de armazenagem (${p.tetoArmazenagem} °C) — risco de envelhecimento acelerado do ligante.`);
    if (tempReceb < p.bombeioMin) out.avisos.push(`Temperatura de recebimento (${tempReceb} °C) abaixo do mínimo usual de bombeio (${p.bombeioMin} °C) — viscosidade pode dificultar a transferência.`);
  }

  return out;
}

// ----------------------------------------------------------------------------
// Hooks de dados
// ----------------------------------------------------------------------------
function useObras() {
  const [obras, setObras] = useState([]);
  useEffect(() => onSnapshot(collection(db, "obras"), (s) => {
    const l = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    l.sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
    setObras(l.filter((o) => o.status === "ativa"));
  }), []);
  return obras;
}
export function useCAPano(ano = anoDe(hojeISO())) {
  const [l, setL] = useState([]);
  useEffect(() => onSnapshot(
    query(collection(db, "cap"), where("ano", "==", ano)),
    (s) => {
      const a = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      a.sort((x, y) => (y.dataRef + (y.criadoEm || "")).localeCompare(x.dataRef + (x.criadoEm || "")));
      setL(a);
    }), [ano]);
  return l;
}
function useCAPobra(obraId) {
  const [l, setL] = useState([]);
  useEffect(() => {
    if (!obraId) return setL([]);
    return onSnapshot(query(collection(db, "cap"), where("obraId", "==", obraId)), (s) => {
      const a = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      a.sort((x, y) => (x.dataRef + (x.criadoEm || "")).localeCompare(y.dataRef + (y.criadoEm || "")));
      setL(a);
    });
  }, [obraId]);
  return l;
}
const cfgCAP = () => { try { return { ...CAP_PADRAO, ...JSON.parse(localStorage.getItem("sc360_cap_cfg") || "{}") }; } catch { return CAP_PADRAO; } };
const salvarCfgCAP = (c) => { try { localStorage.setItem("sc360_cap_cfg", JSON.stringify(c)); } catch {} };
const ctxUsina = () => { try { const f = JSON.parse(localStorage.getItem("sc360_rascunho_carga") || "{}"); return { obraId: f.obraId || "", usina: f.usina || "" }; } catch { return { obraId: "", usina: "" }; } };

// ============================================================================
// ABA CAP — técnico de usina
// ============================================================================
export function TelaCAP({ perfil }) {
  const obras = useObras();
  const ano = anoDe(hojeISO());
  const lista = useCAPano(ano);
  const [form, setForm] = useState(false);
  const [rel, setRel] = useState(null);
  const [etiqueta, setEtiqueta] = useState(null);
  const [cfgOpen, setCfgOpen] = useState(false);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Titulo sub="Recebimento de CAP na usina — acompanhamento, relatório (RAD) e etiqueta da amostra.">Recebimento de CAP</Titulo>
        <button onClick={() => setCfgOpen(!cfgOpen)} style={{ background: "none", border: "none", color: C.mut, fontSize: 20, cursor: "pointer" }} title="Parâmetros técnicos">⚙️</button>
      </div>

      {cfgOpen && <ParametrosCAP fechar={() => setCfgOpen(false)} />}

      {form
        ? <FormCAP perfil={perfil} obras={obras} listaAno={lista} aoFechar={() => setForm(false)} />
        : <Btn onClick={() => setForm(true)} style={{ marginBottom: 12 }}>➕ Novo recebimento de CAP</Btn>}

      {!lista.length && !form && <Cartao><div style={{ color: C.mut, textAlign: "center", padding: 8 }}>Nenhum recebimento de CAP registrado em {ano}.</div></Cartao>}

      {lista.map((c) => (
        <Cartao key={c.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{c.numero} · {c.tipoCap || "CAP 30/45"}</div>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: c.finalizado ? C.ok : C.amber, background: c.finalizado ? C.okBg : C.warnBg, padding: "3px 9px", borderRadius: 99 }}>
              {c.finalizado ? "Finalizado" : "Em acompanhamento"}
            </span>
          </div>
          <Linha k="Obra · NF-e" v={`${c.obraNome || "—"} · ${c.nfe || "—"}`} />
          <Linha k="Recebido em" v={`${fmtBR(c.dataRef)}${c.chegada ? ` · chegada ${c.chegada}` : ""}`} />
          <Linha k="Peso · temperatura" v={`${c.pesoNota ?? "—"} t · ${c.tempRecebimento ?? "—"} °C`} forte />
          <Linha k="Amostra" v={c.amostra || "—"} />
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <Btn cheio={false} onClick={() => setRel(c)} style={{ flex: 1, padding: "10px", minWidth: 130 }}>📄 Relatório RAD</Btn>
            <Btn tom="claro" cheio={false} onClick={() => setEtiqueta(c)} style={{ flex: 1, padding: "10px", minWidth: 130 }}>🏷️ Etiqueta AM-CAP</Btn>
            <Btn tom="claro" cheio={false} onClick={() => setForm(c)} style={{ padding: "10px 14px", color: C.blue }}>✏️</Btn>
          </div>
        </Cartao>
      ))}

      {rel && <RelatorioRAD registro={rel} listaObra={lista} fechar={() => setRel(null)} />}
      {etiqueta && <EtiquetaAmostra registro={etiqueta} fechar={() => setEtiqueta(null)} />}
    </>
  );
}

// ----------------------------------------------------------------------------
// Formulário do recebimento
// ----------------------------------------------------------------------------
function FormCAP({ perfil, obras, listaAno, registro: registroExistente = null, aoFechar }) {
  const ctx = ctxUsina();
  const [f, setF] = useState(() => ({
    obraId: ctx.obraId || "", usina: ctx.usina || "AUTEM — Araraquara",
    tipoCap: "CAP 30/45", nfe: "", serie: "", placaCavalo: "", placaCarreta: "",
    transportadora: "", motorista: "", pesoNota: "", tara: "",
    tempRecebimento: "", tempExpedicao: "",
    dataRef: hojeISO(), chegada: agoraHM(), inicio: "", fim: "",
    obs: "", ...(registroExistente || {}),
  }));
  const [fotosNota, setFotosNota] = useState(registroExistente?.fotosNota || []);
  const [fotos, setFotos] = useState(registroExistente?.fotos || []);
  const [notaLocal, setNotaLocal] = useState([]);
  const [fotosLocais, setFotosLocais] = useState([]);
  const [msg, setMsg] = useState("");
  const [salvando, setSalvando] = useState(false);
  const cfg = cfgCAP();
  const m = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));
  const obra = obras.find((o) => o.id === f.obraId);
  const calc = useMemo(() => calcularCAP(f, cfg), [JSON.stringify(f)]);

  const proximoNumero = () => {
    const ano = anoDe(f.dataRef);
    const doAno = listaAno.filter((c) => c.ano === ano);
    const maxSeq = doAno.reduce((mx, c) => Math.max(mx, c.seq || 0), 0);
    return maxSeq + 1;
  };

  const salvar = async (finalizar) => {
    setMsg("");
    if (!f.obraId) return setMsg("Selecione a obra de destino.");
    if (!f.nfe?.trim()) return setMsg("Informe o número da NF-e.");
    if (num(f.pesoNota) == null) return setMsg("Informe o peso da nota (t).");
    if (num(f.tempRecebimento) == null) return setMsg("Informe a temperatura de recebimento.");
    setSalvando(true);
    try {
      const ano = anoDe(f.dataRef);
      const seq = registroExistente?.seq || proximoNumero();
      const numero = `RAD ${String(seq).padStart(3, "0")}/${ano}`;
      const amostra = `AM-CAP-${String(seq).padStart(3, "0")}`;
      const id = registroExistente?.id || `${ano}_${String(seq).padStart(3, "0")}`;
      const dados = {
        ...f, ano, seq, numero, amostra,
        obraNome: obra?.nome || "", pesoNota: num(f.pesoNota),
        tempRecebimento: num(f.tempRecebimento), tempExpedicao: num(f.tempExpedicao),
        tara: num(f.tara), calc,
        finalizado: !!finalizar,
        criadoPor: perfil.nome, uid: perfil.uid,
        criadoEm: registroExistente?.criadoEm || agoraISO(), ultimaEdicao: { por: perfil.nome, em: agoraISO() },
      };
      const dref = doc(db, "cap", id);
      await setDoc(dref, dados, { merge: true });
      for (const foto of notaLocal) await anexarFoto(`cap/${id}`, "fotosNota", foto, "Nota fiscal (NF-e)");
      for (const foto of fotosLocais) await anexarFoto(`cap/${id}`, "fotos", foto, "Acompanhamento do descarregamento");
      setMsg("ok");
      setTimeout(aoFechar, 800);
    } catch {
      setMsg("Falha ao salvar — verifique a internet e tente de novo.");
    }
    setSalvando(false);
  };

  const Resultado = ({ k, v, alerta }) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px dashed ${C.line}`, fontSize: 13 }}>
      <span style={{ color: C.mut }}>{k}</span>
      <span style={{ fontWeight: 700, color: alerta ? C.red : C.navy }}>{v}</span>
    </div>
  );

  return (
    <Cartao style={{ borderColor: C.navy }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontWeight: 800, color: C.navy }}>🛢️ {registroExistente ? `Editar ${registroExistente.numero}` : "Novo recebimento de CAP"}</div>
        <button onClick={aoFechar} style={{ border: "none", background: "none", color: C.mut, fontWeight: 800, cursor: "pointer" }}>✕</button>
      </div>

      <Sel rotulo="Obra vinculada *" value={f.obraId} onChange={m("obraId")}>
        <option value="">Selecione…</option>
        {obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
      </Sel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Campo rotulo="Usina (local de descarga)" value={f.usina} onChange={m("usina")} />
        <Sel rotulo="Tipo de CAP" value={f.tipoCap} onChange={m("tipoCap")}>
          {["CAP 30/45", "CAP 50/70", "CAP 85/100", "AMP 55/75-E", "AMP 60/85-E"].map((x) => <option key={x}>{x}</option>)}
        </Sel>
      </div>

      {/* Nota fiscal — anexo + campos manuais */}
      <div style={{ fontWeight: 800, color: C.navy, fontSize: 14, margin: "8px 0 6px" }}>Nota fiscal</div>
      <div style={{ fontSize: 12, color: C.mut, background: C.blueBg, borderRadius: 10, padding: "8px 12px", marginBottom: 10 }}>
        📎 Anexe a foto da nota como evidência e preencha os campos abaixo com o que estiver nela.
      </div>
      <BotaoFoto obraNome={obra?.nome} aoLocal={(foto) => setNotaLocal((v) => [...v, foto])} rotulo="📷 Foto da nota fiscal" />
      <Miniaturas fotos={[...fotosNota, ...notaLocal]} aoRemover={(i) => { if (i < fotosNota.length) return; setNotaLocal((v) => v.filter((_, j) => j !== i - fotosNota.length)); }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
        <Campo rotulo="NF-e *" inputMode="numeric" value={f.nfe} onChange={m("nfe")} placeholder="000011724" />
        <Campo rotulo="Série" inputMode="numeric" value={f.serie} onChange={m("serie")} placeholder="2" />
        <Campo rotulo="Peso líquido da nota *" sufixo="t" inputMode="decimal" value={f.pesoNota} onChange={m("pesoNota")} placeholder="29,510" />
        <Campo rotulo="Tara (opcional)" sufixo="kg" inputMode="decimal" value={f.tara} onChange={m("tara")} placeholder="19800" />
        <Campo rotulo="Temp. de recebimento *" sufixo="°C" inputMode="decimal" value={f.tempRecebimento} onChange={m("tempRecebimento")} placeholder="160" />
        <Campo rotulo="Temp. de expedição (se na NF)" sufixo="°C" inputMode="decimal" value={f.tempExpedicao} onChange={m("tempExpedicao")} placeholder="opcional" />
      </div>

      <div style={{ fontWeight: 800, color: C.navy, fontSize: 14, margin: "8px 0 6px" }}>Veículo e transporte</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Campo rotulo="Placa do cavalo" value={f.placaCavalo} onChange={m("placaCavalo")} autoCapitalize="characters" placeholder="FUA-9560" />
        <Campo rotulo="Placa da carreta" value={f.placaCarreta} onChange={m("placaCarreta")} autoCapitalize="characters" placeholder="FWS-8460" />
        <Campo rotulo="Transportadora" value={f.transportadora} onChange={m("transportadora")} />
        <Campo rotulo="Motorista" value={f.motorista} onChange={m("motorista")} />
      </div>

      <div style={{ fontWeight: 800, color: C.navy, fontSize: 14, margin: "8px 0 6px" }}>Tempos do descarregamento</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <Campo rotulo="Data" type="date" value={f.dataRef} onChange={m("dataRef")} />
        <Campo rotulo="Chegada" type="time" value={f.chegada} onChange={m("chegada")} />
        <Campo rotulo="Início" type="time" value={f.inicio} onChange={m("inicio")} />
        <Campo rotulo="Término" type="time" value={f.fim} onChange={m("fim")} />
      </div>

      {/* Fotos gerais do acompanhamento */}
      <div style={{ fontWeight: 800, color: C.navy, fontSize: 14, margin: "8px 0 6px" }}>Fotos do acompanhamento</div>
      <div style={{ fontSize: 12, color: C.mut, marginBottom: 8 }}>Mangote/conexão, termômetro de bordo, costado do tanque, abertura da amostra — mesmo padrão georreferenciado das cargas.</div>
      <BotaoFoto obraNome={obra?.nome} aoLocal={(foto) => setFotosLocais((v) => [...v, foto])} rotulo="📷 Fotos do descarregamento" />
      <Miniaturas fotos={[...fotos, ...fotosLocais]} aoRemover={(i) => { if (i < fotos.length) return; setFotosLocais((v) => v.filter((_, j) => j !== i - fotos.length)); }} />

      {/* Prévia das relações calculadas */}
      {(calc.fator || calc.kgMin) && (
        <div style={{ background: C.grayBg, borderRadius: 12, padding: 12, marginTop: 12 }}>
          <div style={{ fontWeight: 800, color: C.navy, fontSize: 13.5, marginBottom: 6 }}>📐 Relações calculadas (prévia)</div>
          {calc.fator && <Resultado k="Fator de correção volumétrica" v={fmt(calc.fator, 4)} />}
          {calc.densCorr && <Resultado k={`Densidade a ${f.tempRecebimento} °C`} v={`${fmt(calc.densCorr, 3)} g/cm³`} />}
          {calc.volReceb && <Resultado k="Volume na temperatura" v={`≈ ${fmt(calc.volReceb, 0)} L`} />}
          {calc.volRef && <Resultado k="Volume a 25 °C (estoque)" v={`≈ ${fmt(calc.volRef, 0)} L`} />}
          {calc.ocup && <Resultado k="Ocupação do tanque" v={`≈ ${fmt(calc.ocup, 0)} %`} alerta={calc.ocup > 100} />}
          {calc.kgMin && <Resultado k="Taxa de transferência" v={`${fmt(calc.kgMin, 1)} kg/min · ${fmt(calc.tH, 1)} t/h`} />}
          {calc.lMin && <Resultado k="Vazão volumétrica" v={`${fmt(calc.lMin, 0)} L/min · ${fmt(calc.m3H, 1)} m³/h`} />}
          {calc.cbuqMin && <Resultado k="Potencial de CBUQ" v={`${fmt(calc.cbuqMin, 0)}–${fmt(calc.cbuqMax, 0)} t`} />}
          {calc.perdaTermica != null && <Resultado k="Perda térmica no trajeto" v={`${fmt(calc.perdaTermica, 1)} °C`} />}
          {calc.avisos.map((a, i) => <div key={i} style={{ background: C.warnBg, color: C.amber, fontSize: 12, fontWeight: 600, borderRadius: 8, padding: "6px 10px", marginTop: 6 }}>⚠️ {a}</div>)}
        </div>
      )}

      <Campo rotulo="Observações" value={f.obs} onChange={m("obs")} style={{ marginTop: 12 }} placeholder="Ocorrências, paradas de bombeio, aspecto do produto…" />
      {msg === "ok" && <div style={{ color: C.ok, fontWeight: 700, fontSize: 14, marginBottom: 8, textAlign: "center" }}>✅ Recebimento salvo.</div>}
      {msg && msg !== "ok" && <div style={{ color: C.red, fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>{msg}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Btn tom="claro" onClick={() => salvar(false)} disabled={salvando}>{salvando ? "Salvando…" : "💾 Salvar rascunho"}</Btn>
        <Btn tom="ok" onClick={() => salvar(true)} disabled={salvando}>{salvando ? "Salvando…" : "✔ Finalizar"}</Btn>
      </div>
    </Cartao>
  );
}

// ----------------------------------------------------------------------------
// Parâmetros técnicos do CAP (persistidos no aparelho)
// ----------------------------------------------------------------------------
function ParametrosCAP({ fechar }) {
  const [c, setC] = useState(cfgCAP());
  const m = (k) => (e) => setC({ ...c, [k]: num(e.target.value) ?? e.target.value });
  const salvar = () => { salvarCfgCAP(c); fechar(); };
  return (
    <Cartao style={{ borderColor: C.navy }}>
      <div style={{ fontWeight: 800, color: C.navy, marginBottom: 4 }}>⚙️ Parâmetros técnicos do CAP</div>
      <div style={{ fontSize: 12, color: C.mut, marginBottom: 10 }}>Valores típicos do CAP 30/45 — confirme com o laudo do lote. Alimentam todos os cálculos do relatório.</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Campo rotulo="Densidade a 25 °C" sufixo="g/cm³" inputMode="decimal" value={c.densidade25} onChange={m("densidade25")} />
        <Campo rotulo="Coef. de expansão térmica" sufixo="/°C" inputMode="decimal" value={c.coefExpansao} onChange={m("coefExpansao")} />
        <Campo rotulo="Capacidade do tanque" sufixo="L" inputMode="numeric" value={c.capacidadeTanque} onChange={m("capacidadeTanque")} />
        <Campo rotulo="Teto de armazenagem" sufixo="°C" inputMode="numeric" value={c.tetoArmazenagem} onChange={m("tetoArmazenagem")} />
        <Campo rotulo="Mínimo de bombeio" sufixo="°C" inputMode="numeric" value={c.bombeioMin} onChange={m("bombeioMin")} />
        <Campo rotulo="Ponto de fulgor mínimo" sufixo="°C" inputMode="numeric" value={c.pontoFulgorMin} onChange={m("pontoFulgorMin")} />
        <Campo rotulo="Teor de projeto — mín." sufixo="%" inputMode="decimal" value={c.teorMin} onChange={m("teorMin")} />
        <Campo rotulo="Teor de projeto — máx." sufixo="%" inputMode="decimal" value={c.teorMax} onChange={m("teorMax")} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn onClick={salvar} style={{ flex: 1 }}>💾 Salvar parâmetros</Btn>
        <Btn tom="claro" cheio={false} onClick={fechar} style={{ padding: "13px 18px" }}>Fechar</Btn>
      </div>
    </Cartao>
  );
}

// ============================================================================
// RELATÓRIO RAD — replica o modelo Solocontrol (2 folhas + análise técnica)
// ============================================================================
function FotosGrade({ fotos, titulo }) {
  const fs = (fotos || []).filter((f) => f.url);
  if (!fs.length) return null;
  return (
    <>
      <div style={secRel}>{titulo}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        {fs.map((f) => (
          <figure key={f.id} style={{ margin: 0, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", breakInside: "avoid" }}>
            <img src={f.url} alt="" style={{ width: "100%", height: 150, objectFit: "cover", display: "block" }} />
            <figcaption style={{ fontSize: 8.5, padding: "3px 6px", color: C.mut }}>{f.legenda || "Registro"} {f.utm ? `· ${f.utm}` : ""}</figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}

function RelatorioRAD({ registro: c, listaObra, fechar }) {
  const cfg = cfgCAP();
  const r = c.calc || calcularCAP(c, cfg);
  const anterior = useMemo(() => {
    const daObra = (listaObra || []).filter((x) => x.obraId === c.obraId && x.seq < c.seq);
    return daObra.sort((a, b) => b.seq - a.seq)[0] || null;
  }, [c.id]);
  const linhaTab = (rot, val, base) => (
    <tr><td style={{ ...tabTd, width: "44%" }} className="rot">{rot}</td><td style={{ ...tabTd, width: "22%", fontWeight: 700 }}>{val}</td><td style={{ ...tabTd, color: C.mut }}>{base}</td></tr>
  );

  return (
    <Impressao fechar={fechar} nomeArquivo={`${c.numero.replace(/[ /]/g, "-")}.pdf`}>
      {/* ---------- FOLHA 1 ---------- */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: `3px solid ${C.navy}`, paddingBottom: 10 }}>
        <Logo s={46} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 22, color: C.navy }}>SOLOCONTROL</div>
          <div style={{ fontSize: 11, color: C.mut }}>Qualidade que constrói confiança · Controle tecnológico de pavimentação</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 14, color: C.red }}>RELATÓRIO DE ACOMPANHAMENTO<br />DE DESCARREGAMENTO</div>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{c.numero}</div>
          <div style={{ fontSize: 11, color: C.mut }}>Amostra: {c.amostra} · Emissão {fmtBR(c.dataRef)}</div>
        </div>
      </div>
      <div style={{ fontFamily: F.disp, fontWeight: 700, fontSize: 16, color: C.navy, margin: "12px 0 4px" }}>
        Recebimento de Cimento Asfáltico de Petróleo {c.tipoCap}
      </div>
      <div style={{ fontSize: 12, color: C.mut }}>
        {c.usina} · Obra: {c.obraNome} · NF-e {c.nfe}{c.serie ? `, Série ${c.serie}` : ""}
      </div>

      <div style={secRel}>01 · Identificação do serviço</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        {linhaTab("Data do acompanhamento", fmtBR(c.dataRef), "")}
        {linhaTab("Local de descarga", c.usina, "Estoque de matéria-prima da usina")}
        {linhaTab("Obra vinculada", c.obraNome, "")}
        {linhaTab("Produto", c.tipoCap, `NF-e ${c.nfe}${c.serie ? ` · Série ${c.serie}` : ""}`)}
        {linhaTab("Técnico responsável", c.criadoPor || "—", "Solocontrol")}
      </tbody></table>

      <div style={secRel}>02 · Veículo e transporte</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        {linhaTab("Placa do cavalo / carreta", `${c.placaCavalo || "—"} / ${c.placaCarreta || "—"}`, "")}
        {linhaTab("Transportadora", c.transportadora || "—", "")}
        {linhaTab("Motorista", c.motorista || "—", "")}
      </tbody></table>

      <div style={secRel}>03 · Tempos e temperaturas</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        {linhaTab("Chegada", c.chegada || "—", "")}
        {linhaTab("Início / término da descarga", `${c.inicio || "—"} → ${c.fim || "—"}`, r.dur ? `Duração ${fmtMin(r.dur)}` : "")}
        {linhaTab("Permanência total", fmtMin(r.permanencia), "Chegada → término")}
        {linhaTab("Temperatura de recebimento", `${c.tempRecebimento} °C`, "Termômetro de bordo, na conexão do mangote")}
        {c.tempExpedicao != null && linhaTab("Temperatura de expedição (NF)", `${c.tempExpedicao} °C`, "")}
      </tbody></table>

      <FotosGrade titulo="Registro fotográfico — nota fiscal e veículo" fotos={c.fotosNota} />

      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 18, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        SOLOCONTROL · CONTROLE TECNOLÓGICO DE PAVIMENTAÇÃO · {c.numero} · {fmtBR(c.dataRef)} · Folha 1
      </div>

      {/* ---------- FOLHA 2 · ANÁLISE TÉCNICA ---------- */}
      <div style={{ breakBefore: "page", pageBreakBefore: "always", height: 0 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: `3px solid ${C.navy}`, paddingBottom: 10, marginTop: 20 }}>
        <Logo s={40} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 20, color: C.navy }}>SOLOCONTROL</div>
          <div style={{ fontSize: 10.5, color: C.mut }}>Análise técnica — relações apuradas</div>
        </div>
        <div style={{ textAlign: "right", fontSize: 11, color: C.mut }}>
          <div style={{ fontWeight: 700, color: C.ink }}>{c.numero}</div>
          {c.tipoCap} · NF-e {c.nfe}<br />Folha 2
        </div>
      </div>

      <div style={secRel}>04 · Massa, volume e correção térmica</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={tabTh}>Relação</th><th style={tabTh}>Valor</th><th style={tabTh}>Base de cálculo</th></tr></thead>
        <tbody>
          {linhaTab("Massa líquida recebida", `${fmt(c.pesoNota, 3)} t`, "Documento fiscal")}
          {linhaTab("Densidade adotada a 25 °C", `${fmt(cfg.densidade25, 3)} g/cm³`, "Valor típico — a confirmar em ensaio")}
          {r.densCorr && linhaTab(`Densidade estimada a ${c.tempRecebimento} °C`, `${fmt(r.densCorr, 3)} g/cm³`, `Coef. de expansão ${cfg.coefExpansao} /°C`)}
          {r.fator && linhaTab(`Fator de correção volumétrica (${c.tempRecebimento} → 25 °C)`, fmt(r.fator, 4), "1 / [1 + coef × ΔT]")}
          {r.volReceb && linhaTab("Volume equivalente na temperatura", `≈ ${fmt(r.volReceb, 0)} L`, "Massa ÷ densidade corrigida")}
          {r.volRef && linhaTab("Volume equivalente a 25 °C", `≈ ${fmt(r.volRef, 0)} L`, "Base de conferência de estoque")}
          {r.ocup && linhaTab(`Ocupação da capacidade grafada (${cfg.capacidadeTanque.toLocaleString("pt-BR")} L)`, `≈ ${fmt(r.ocup, 0)} %`, r.ocup > 100 ? "⚠ Verificar" : "")}
        </tbody>
      </table>

      <div style={secRel}>05 · Transferência e potencial de produção</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={tabTh}>Relação</th><th style={tabTh}>Valor</th><th style={tabTh}>Base de cálculo</th></tr></thead>
        <tbody>
          {r.kgMin && linhaTab("Taxa de transferência", `${fmt(r.kgMin, 1)} kg/min · ${fmt(r.tH, 1)} t/h`, `Massa ÷ ${fmtMin(r.dur)} de descarga`)}
          {r.lMin && linhaTab("Vazão volumétrica média", `${fmt(r.lMin, 0)} L/min · ${fmt(r.m3H, 1)} m³/h`, "Taxa ÷ densidade corrigida")}
          {r.cbuqMin && linhaTab("Potencial de produção de CBUQ", `${fmt(r.cbuqMin, 0)}–${fmt(r.cbuqMax, 0)} t`, `Teor de projeto ${cfg.teorMin}–${cfg.teorMax}%`)}
          {r.perdaTermica != null && linhaTab("Perda térmica no trajeto", `${fmt(r.perdaTermica, 1)} °C${r.perdaHora != null ? ` (${fmt(r.perdaHora, 2)} °C/h)` : ""}`, "Expedição − recebimento")}
        </tbody>
      </table>

      <div style={secRel}>06 · Situação térmica do recebimento</div>
      <div style={{ fontSize: 11.5, lineHeight: 1.55, color: C.ink }}>
        A temperatura de <b>{c.tempRecebimento} °C</b>, medida no termômetro de bordo na conexão do mangote,
        {r.tempOk
          ? <> situa-se <b>dentro da faixa operacional</b>: acima do mínimo usual de bombeio ({cfg.bombeioMin} °C) e abaixo do teto de armazenagem ({cfg.tetoArmazenagem} °C).</>
          : <> está <b style={{ color: C.red }}>fora da faixa operacional</b> ({cfg.bombeioMin}–{cfg.tetoArmazenagem} °C) — ver ponto de atenção.</>}
        {r.margemTeto != null && <> Margem de <b>{fmt(r.margemTeto, 0)} °C</b> até o teto de armazenagem e de <b>{fmt(r.margemFulgor, 0)} °C</b> até o ponto de fulgor mínimo especificado ({cfg.pontoFulgorMin} °C).</>}
        {" "}Os critérios definitivos são os do projeto e da especificação contratual cadastrados.
      </div>

      {anterior && (
        <>
          <div style={secRel}>07 · Comparação com a remessa anterior ({anterior.numero})</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={tabTh}>Relação</th><th style={tabTh}>Esta remessa</th><th style={tabTh}>{anterior.numero} · {fmtBR(anterior.dataRef)}</th></tr></thead>
            <tbody>
              {linhaTab("Peso líquido", `${fmt(c.pesoNota, 3)} t`, `${fmt(anterior.pesoNota, 3)} t`)}
              {linhaTab("Temperatura de recebimento", `${c.tempRecebimento} °C`, `${anterior.tempRecebimento} °C`)}
              {(r.kgMin && anterior.calc?.kgMin) && linhaTab("Taxa de transferência", `${fmt(r.kgMin, 1)} kg/min`, `${fmt(anterior.calc.kgMin, 1)} kg/min`)}
              {(r.ocup && anterior.calc?.ocup) && linhaTab("Ocupação do tanque", `${fmt(r.ocup, 0)} %`, `${fmt(anterior.calc.ocup, 0)} %`)}
            </tbody>
          </table>
        </>
      )}

      {r.avisos.length > 0 && (
        <>
          <div style={secRel}>Pontos de atenção</div>
          {r.avisos.map((a, i) => (
            <div key={i} style={{ background: C.warnBg, color: C.amber, fontSize: 11.5, fontWeight: 600, borderRadius: 9, padding: "8px 12px", marginBottom: 6 }}>▲ {a}</div>
          ))}
        </>
      )}

      {c.obs && <><div style={secRel}>Observações do acompanhamento</div><div style={{ fontSize: 11.5, whiteSpace: "pre-wrap" }}>{c.obs}</div></>}

      <FotosGrade titulo="Registro fotográfico — descarregamento" fotos={c.fotos} />

      <div style={{ background: C.blueBg, borderRadius: 10, padding: "10px 14px", margin: "14px 0", fontSize: 11, color: C.ink }}>
        <b>Nota.</b> As relações acima são estimativas de acompanhamento de campo, calculadas a partir dos dados fiscais e da temperatura medida em campo.
        O <b>certificado de caracterização do CAP é emitido pelo laboratório</b>, não pelo acompanhamento em campo. Recomenda-se obter a densidade
        relativa do lote no laudo e refazer as conversões volumétricas.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 30, marginTop: 40, breakInside: "avoid" }}>
        {[`${c.criadoPor || "Técnico responsável"} — Solocontrol`, "Motorista / transportador"].map((rr) => (
          <div key={rr} style={{ textAlign: "center" }}><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 5, fontSize: 11 }}>{rr}</div></div>
        ))}
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Documento gerado pelo sistema Solocontrol em {fmtDataHora()} · {c.numero} · Amostra {c.amostra} · Registros georreferenciados e auditáveis.
      </div>
    </Impressao>
  );
}

// ============================================================================
// ETIQUETA DA AMOSTRA (AM-CAP) — para colar no recipiente
// ============================================================================
function EtiquetaAmostra({ registro: c, fechar }) {
  return (
    <Impressao fechar={fechar} nomeArquivo={`${c.amostra}.pdf`}>
      <div style={{ maxWidth: 420, margin: "0 auto", border: `2px solid ${C.navy}`, borderRadius: 14, overflow: "hidden" }}>
        <div style={{ background: C.navy, color: "#fff", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          <Logo s={34} />
          <div>
            <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 18, letterSpacing: 0.5 }}>SOLOCONTROL</div>
            <div style={{ fontSize: 10, color: "#AEB8E0" }}>Etiqueta de amostra · Controle tecnológico</div>
          </div>
        </div>
        <div style={{ padding: 18 }}>
          <div style={{ textAlign: "center", marginBottom: 14 }}>
            <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 34, color: C.red, lineHeight: 1 }}>{c.amostra}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.mut, marginTop: 4 }}>Vinculada ao {c.numero}</div>
          </div>
          <Linha k="Produto" v={c.tipoCap} forte />
          <Linha k="NF-e" v={`${c.nfe}${c.serie ? ` · Série ${c.serie}` : ""}`} />
          <Linha k="Obra" v={c.obraNome} />
          <Linha k="Usina / local" v={c.usina} />
          <Linha k="Data de coleta" v={fmtBR(c.dataRef)} />
          <Linha k="Temp. no recebimento" v={`${c.tempRecebimento} °C`} />
          <Linha k="Placa (cavalo/carreta)" v={`${c.placaCavalo || "—"} / ${c.placaCarreta || "—"}`} />
          <Linha k="Coletado por" v={c.criadoPor || "—"} />
          <div style={{ background: C.warnBg, borderRadius: 8, padding: "8px 12px", marginTop: 12, fontSize: 11, color: C.amber, fontWeight: 600 }}>
            Caracterização a cargo do laboratório. Manter a amostra identificada e ao abrigo de contaminação.
          </div>
        </div>
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 14, textAlign: "center" }}>
        Gerada pelo sistema Solocontrol em {fmtDataHora()}
      </div>
    </Impressao>
  );
}

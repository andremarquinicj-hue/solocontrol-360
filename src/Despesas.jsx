// ============================================================================
// SOLOCONTROL 360 · MÓDULO DESPESAS DE VIAGEM
// Liberado por funcionário (interruptor na ficha, igual ao ponto).
// O funcionário abre uma VIAGEM (início/fim), lança as despesas dia a dia —
// combustível (litros + valor + posto + comprovante), pedágio e outras — e o
// km rodado no dia. Ao fechar, o sistema calcula o total e as médias:
//   • R$/km rodado (custo total ÷ km total)
//   • R$/km só de combustível
//   • km/L (rendimento) e R$/L médio
// Gera o relatório da viagem em PDF com a tabela diária e os comprovantes.
// ----------------------------------------------------------------------------
// Autossuficiente: reaproveita o kit visual/PDF do Pessoal.jsx; pipeline de
// fotos (comprovantes georreferenciados) embutido aqui.
// ============================================================================
import React, { useState, useEffect, useMemo, useRef } from "react";
import { db, storage } from "./firebase";
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, arrayUnion,
} from "firebase/firestore";
import { ref as sRef, uploadString, getDownloadURL } from "firebase/storage";
import {
  C, F, Btn, Campo, Sel, Cartao, Titulo, Linha, Logo, Impressao,
  secRel, tabTh, tabTd, hojeISO, agoraHM, agoraISO, fmtBR, fmtDataHora, num, pegarGPS,
} from "./Pessoal.jsx";

const rid = () => Math.random().toString(36).slice(2, 10);
const brl = (v) => (v == null || isNaN(v) ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const nfmt = (v, c = 2) => (v == null || isNaN(v) ? "—" : v.toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c }));

const TIPOS = [
  { id: "combustivel", rot: "Combustível", ico: "⛽" },
  { id: "pedagio", rot: "Pedágio", ico: "🛣️" },
  { id: "alimentacao", rot: "Alimentação", ico: "🍽️" },
  { id: "hospedagem", rot: "Hospedagem", ico: "🏨" },
  { id: "outro", rot: "Outro", ico: "🧾" },
];
const tipoInfo = (id) => TIPOS.find((t) => t.id === id) || TIPOS[4];

// ----------------------------------------------------------------------------
// Foto do comprovante — georreferenciada (data/hora, UTM, SOLOCONTROL)
// ----------------------------------------------------------------------------
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
function dataExtenso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()} às ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function prepararComprovante(file) {
  const utm = await pegarGPS();
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = b64; });
  const MAX = 1400;
  const esc = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.round(img.width * esc), h = Math.round(img.height * esc);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const base = Math.min(w, h);
  const linhas = [dataExtenso(), utm || "GPS indisponível", "SOLOCONTROL · comprovante"];
  const fs = Math.round(base * 0.042), lh = Math.round(fs * 1.32), mg = Math.round(base * 0.028);
  ctx.font = `700 ${fs}px Arial, sans-serif`; ctx.textAlign = "right"; ctx.textBaseline = "alphabetic";
  linhas.forEach((l, i) => {
    const y = h - mg - (linhas.length - 1 - i) * lh;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.85)"; ctx.shadowBlur = Math.round(fs * 0.5);
    ctx.lineWidth = Math.max(2, Math.round(fs * 0.11)); ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.strokeText(l, w - mg, y);
    ctx.shadowColor = "transparent"; ctx.fillStyle = "#fff"; ctx.fillText(l, w - mg, y);
    ctx.restore();
  });
  return { id: rid(), b64: cv.toDataURL("image/jpeg", 0.8), utm: utm || "", hora: agoraHM() };
}
async function subirComprovante(viagemId, foto) {
  const path = `comprovantes/${viagemId}/${foto.id}.jpg`;
  try { const r = sRef(storage, path); await uploadString(r, foto.b64, "data_url"); return await getDownloadURL(r); }
  catch { return null; }
}

// Compressão simples, sem marca d'água — para o print do mapa (opcional).
async function comprimirImagem(file) {
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = b64; });
  const MAX = 1600;
  const esc = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.round(img.width * esc), h = Math.round(img.height * esc);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(img, 0, 0, w, h);
  return { id: rid(), b64: cv.toDataURL("image/jpeg", 0.82) };
}
async function subirMapa(viagemId, foto) {
  const path = `mapas/${viagemId}/${foto.id}.jpg`;
  try { const r = sRef(storage, path); await uploadString(r, foto.b64, "data_url"); return await getDownloadURL(r); }
  catch { return null; }
}
// Anexo do print do mapa (opcional) — aceita vários, com miniaturas.
function MapaUploader({ mapas = [], aoAnexar, aoRemover }) {
  const refFile = useRef(null);
  const [ocupado, setOcupado] = useState(false);
  const processar = async (files) => {
    if (!files?.length) return;
    setOcupado(true);
    try { for (const f of files) await aoAnexar(f); }
    finally { setOcupado(false); }
  };
  return (
    <>
      <input ref={refFile} type="file" accept="image/*" multiple style={{ display: "none" }}
        onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ""; processar(fs); }} />
      <Btn tom="claro" cheio={false} onClick={() => refFile.current?.click()} disabled={ocupado} style={{ padding: "10px 14px" }}>
        {ocupado ? "Enviando…" : "🗺️ Anexar print do mapa"}
      </Btn>
      {!!mapas.length && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {mapas.map((mp) => (
            <div key={mp.id} style={{ position: "relative" }}>
              <img src={mp.url || mp.b64} alt="" style={{ width: 90, height: 66, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}` }} />
              {!mp.url && <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,.35)", borderRadius: 8, display: "grid", placeItems: "center", color: "#fff", fontSize: 10, fontWeight: 700 }}>enviando…</div>}
              <button onClick={() => aoRemover(mp.id)} style={{ position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: 99, border: "none", background: C.red, color: "#fff", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>×</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function BotaoComprovante({ aoAnexar, rotulo = "📷 Comprovante" }) {
  const refCam = useRef(null), refGal = useRef(null);
  const [ocupado, setOcupado] = useState(false);
  const processar = async (files) => {
    if (!files?.length) return;
    setOcupado(true);
    try { const foto = await prepararComprovante(files[0]); aoAnexar && aoAnexar(foto); }
    finally { setOcupado(false); }
  };
  return (
    <>
      <input ref={refCam} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
        onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ""; processar(fs); }} />
      <input ref={refGal} type="file" accept="image/*" style={{ display: "none" }}
        onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ""; processar(fs); }} />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn tom="claro" cheio={false} onClick={() => refCam.current?.click()} disabled={ocupado} style={{ padding: "10px", flex: 1.3 }}>{ocupado ? "…" : rotulo}</Btn>
        <Btn tom="claro" cheio={false} onClick={() => refGal.current?.click()} disabled={ocupado} style={{ padding: "10px", flex: 1 }}>🖼️ Galeria</Btn>
      </div>
    </>
  );
}

// ----------------------------------------------------------------------------
// Totais e médias de uma viagem
// ----------------------------------------------------------------------------
export function totaisViagem(v) {
  const dias = v?.dias || [];
  let kmTotal = 0, litrosTotal = 0, tot = { combustivel: 0, pedagio: 0, alimentacao: 0, hospedagem: 0, outro: 0 };
  dias.forEach((d) => {
    kmTotal += num(d.km) || 0;
    (d.itens || []).forEach((it) => {
      const val = num(it.valor) || 0;
      tot[it.tipo] = (tot[it.tipo] || 0) + val;
      if (it.tipo === "combustivel") litrosTotal += num(it.litros) || 0;
    });
  });
  const totalGeral = Object.values(tot).reduce((a, b) => a + b, 0);
  return {
    kmTotal, litrosTotal, ...tot, totalGeral,
    custoPorKm: kmTotal > 0 ? totalGeral / kmTotal : null,             // R$/km (tudo)
    combPorKm: kmTotal > 0 ? tot.combustivel / kmTotal : null,         // R$/km (só combustível)
    kmPorLitro: litrosTotal > 0 ? kmTotal / litrosTotal : null,        // rendimento
    precoMedioLitro: litrosTotal > 0 ? tot.combustivel / litrosTotal : null,
    diasCount: dias.length,
  };
}

// ----------------------------------------------------------------------------
// Hooks
// ----------------------------------------------------------------------------
function useMinhasViagens(uid) {
  const [l, setL] = useState([]);
  useEffect(() => {
    if (!uid) return setL([]);
    return onSnapshot(query(collection(db, "viagens"), where("uid", "==", uid)), (s) => {
      const a = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      a.sort((x, y) => (y.dataInicio || "").localeCompare(x.dataInicio || ""));
      setL(a);
    });
  }, [uid]);
  return l;
}
export function useTodasViagens() {
  const [l, setL] = useState([]);
  useEffect(() => onSnapshot(collection(db, "viagens"), (s) => {
    const a = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    a.sort((x, y) => (y.dataInicio || "").localeCompare(x.dataInicio || ""));
    setL(a);
  }), []);
  return l;
}
function useObras() {
  const [o, setO] = useState([]);
  useEffect(() => onSnapshot(collection(db, "obras"), (s) => {
    const l = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.status === "ativa");
    l.sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
    setO(l);
  }), []);
  return o;
}

// ============================================================================
// TELA DO FUNCIONÁRIO — minhas viagens
// ============================================================================
export function TelaDespesas({ perfil }) {
  const viagens = useMinhasViagens(perfil.uid);
  const obras = useObras();
  const [edit, setEdit] = useState(null);   // viagem em edição
  const [rel, setRel] = useState(null);     // viagem para relatório

  if (edit) return <EditorViagem perfil={perfil} obras={obras} viagem={edit} aoFechar={() => setEdit(null)} />;

  return (
    <>
      <Titulo sub="Combustível, pedágio e outras despesas por viagem — com km rodado e média de custo por km.">Despesas de viagem</Titulo>
      <Btn onClick={() => setEdit({ novo: true })} style={{ marginBottom: 12 }}>➕ Nova viagem</Btn>

      {!viagens.length && <Cartao><div style={{ color: C.mut, textAlign: "center", padding: 8 }}>Nenhuma viagem registrada ainda.</div></Cartao>}

      {viagens.map((v) => {
        const t = totaisViagem(v);
        return (
          <Cartao key={v.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{v.titulo || "Viagem"}</div>
              <span style={{ fontSize: 11, fontWeight: 800, color: v.status === "fechada" ? C.ok : C.amber, background: v.status === "fechada" ? C.okBg : C.warnBg, padding: "3px 9px", borderRadius: 99 }}>
                {v.status === "fechada" ? "Fechada" : "Aberta"}
              </span>
            </div>
            <Linha k="Período" v={`${fmtBR(v.dataInicio)} → ${fmtBR(v.dataFim || v.dataInicio)} · ${t.diasCount} dia(s)`} />
            <Linha k="Veículo" v={`${v.veiculo || "—"}${v.placa ? ` · ${v.placa}` : ""}`} />
            <Linha k="Km rodado" v={`${nfmt(t.kmTotal, 0)} km`} />
            <Linha k="Total" v={brl(t.totalGeral)} forte />
            <Linha k="Custo por km" v={t.custoPorKm != null ? `${brl(t.custoPorKm)}/km` : "—"} forte />
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <Btn cheio={false} onClick={() => setRel(v)} style={{ flex: 1, padding: "10px", minWidth: 120 }}>📄 Relatório</Btn>
              <Btn tom="claro" cheio={false} onClick={() => setEdit(v)} style={{ flex: 1, padding: "10px", minWidth: 120 }}>✏️ Editar</Btn>
            </div>
          </Cartao>
        );
      })}

      {rel && <RelatorioViagem viagem={rel} perfil={perfil} fechar={() => setRel(null)} />}
    </>
  );
}

// ----------------------------------------------------------------------------
// Editor da viagem (cabeçalho + dias + itens de despesa)
// ----------------------------------------------------------------------------
function EditorViagem({ perfil, obras, viagem, aoFechar }) {
  const novo = viagem.novo;
  const [v, setV] = useState(() => novo ? {
    titulo: "", obraId: "", veiculo: "", placa: "",
    dataInicio: hojeISO(), dataFim: hojeISO(), status: "aberta", dias: [],
  } : { ...viagem });
  const [msg, setMsg] = useState("");
  const [salvando, setSalvando] = useState(false);
  const t = useMemo(() => totaisViagem(v), [JSON.stringify(v)]);
  const setC = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value }));
  const obra = obras.find((o) => o.id === v.obraId);

  const addDia = () => setV((x) => ({ ...x, dias: [...(x.dias || []), { id: rid(), data: x.dataFim || hojeISO(), km: "", itens: [], obs: "" }] }));
  const setDia = (id, patch) => setV((x) => ({ ...x, dias: x.dias.map((d) => d.id === id ? { ...d, ...patch } : d) }));
  const delDia = (id) => setV((x) => ({ ...x, dias: x.dias.filter((d) => d.id !== id) }));
  const addItem = (diaId, tipo) => setDia(diaId, { itens: [...(v.dias.find((d) => d.id === diaId).itens || []), { id: rid(), tipo, valor: "", litros: "", posto: "", foto: null }] });
  const setItem = (diaId, itemId, patch) => {
    const dia = v.dias.find((d) => d.id === diaId);
    setDia(diaId, { itens: dia.itens.map((it) => it.id === itemId ? { ...it, ...patch } : it) });
  };
  const delItem = (diaId, itemId) => {
    const dia = v.dias.find((d) => d.id === diaId);
    setDia(diaId, { itens: dia.itens.filter((it) => it.id !== itemId) });
  };

  const anexar = async (diaId, itemId, foto) => {
    setItem(diaId, itemId, { foto: { ...foto, url: null } });          // mostra prévia local
    const vid = v.id || `${perfil.uid}_${v.dataInicio}`;
    const url = await subirComprovante(vid, foto);
    setItem(diaId, itemId, { foto: { id: foto.id, url, utm: foto.utm, hora: foto.hora, b64: url ? null : foto.b64 } });
  };

  const anexarMapa = async (file) => {
    const foto = await comprimirImagem(file);
    setV((x) => ({ ...x, mapas: [...(x.mapas || []), { ...foto, url: null }] }));  // prévia local
    const vid = v.id || `${perfil.uid}_${v.dataInicio}`;
    const url = await subirMapa(vid, foto);
    setV((x) => ({ ...x, mapas: (x.mapas || []).map((mp) => mp.id === foto.id ? { id: foto.id, url, b64: url ? null : foto.b64 } : mp) }));
  };
  const removerMapa = (id) => setV((x) => ({ ...x, mapas: (x.mapas || []).filter((mp) => mp.id !== id) }));

  const salvar = async (fechar) => {
    setMsg("");
    if (!v.titulo?.trim()) return setMsg("Dê um título/destino à viagem.");
    if (!v.dataInicio) return setMsg("Informe a data de início.");
    setSalvando(true);
    try {
      const id = v.id || `${perfil.uid}_${v.dataInicio}_${rid().slice(0, 4)}`;
      // Remove os b64 locais (só a URL do Storage vai pro Firestore, evita estourar 1 MB/doc)
      const diasLimpos = (v.dias || []).map((d) => ({
        ...d,
        itens: (d.itens || []).map((it) => it.foto ? { ...it, foto: { id: it.foto.id, url: it.foto.url || null, utm: it.foto.utm || "", hora: it.foto.hora || "" } } : it),
      }));
      const mapasLimpos = (v.mapas || []).filter((mp) => mp.url).map((mp) => ({ id: mp.id, url: mp.url }));
      const limpo = {
        ...v, id, dias: diasLimpos, mapas: mapasLimpos,
        obraNome: obra?.nome || v.obraNome || "",
        status: fechar ? "fechada" : "aberta",
        uid: perfil.uid, funcNome: perfil.nome,
        totais: totaisViagem(v),
        criadoEm: v.criadoEm || agoraISO(), atualizadoEm: agoraISO(),
      };
      await setDoc(doc(db, "viagens", id), limpo, { merge: true });
      setMsg("ok");
      setTimeout(aoFechar, 700);
    } catch { setMsg("Falha ao salvar — verifique a internet."); }
    setSalvando(false);
  };

  return (
    <Cartao style={{ borderColor: C.navy }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontWeight: 800, color: C.navy }}>🚗 {novo ? "Nova viagem" : "Editar viagem"}</div>
        <button onClick={aoFechar} style={{ border: "none", background: "none", color: C.mut, fontWeight: 800, cursor: "pointer" }}>✕</button>
      </div>

      <Campo rotulo="Título / destino *" value={v.titulo} onChange={setC("titulo")} placeholder="Ex.: Entrega EMBRAER — Gavião Peixoto" />
      <Sel rotulo="Obra (opcional)" value={v.obraId} onChange={setC("obraId")}>
        <option value="">— não vincular —</option>
        {obras.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
      </Sel>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Campo rotulo="Veículo" value={v.veiculo} onChange={setC("veiculo")} placeholder="Ford Transit" />
        <Campo rotulo="Placa" value={v.placa} onChange={setC("placa")} autoCapitalize="characters" />
        <Campo rotulo="Início *" type="date" value={v.dataInicio} onChange={setC("dataInicio")} />
        <Campo rotulo="Fim" type="date" value={v.dataFim} onChange={setC("dataFim")} />
      </div>

      {/* Resumo em tempo real */}
      <div style={{ background: C.navy, color: "#fff", borderRadius: 12, padding: 14, margin: "12px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontSize: 12.5, color: "#AEB8E0" }}>Total da viagem</span>
          <span style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 26 }}>{brl(t.totalGeral)}</span>
        </div>
        <div style={{ display: "flex", gap: 14, marginTop: 6, flexWrap: "wrap", fontSize: 12.5 }}>
          <span>🛣️ {nfmt(t.kmTotal, 0)} km</span>
          <span>⛽ {nfmt(t.litrosTotal, 1)} L</span>
          <span style={{ fontWeight: 800 }}>{t.custoPorKm != null ? `${brl(t.custoPorKm)}/km` : "—/km"}</span>
          {t.kmPorLitro != null && <span>{nfmt(t.kmPorLitro, 1)} km/L</span>}
        </div>
      </div>

      {/* Print do mapa (opcional) */}
      <div style={{ border: `1px dashed ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
        <div style={{ fontWeight: 800, color: C.navy, fontSize: 14, marginBottom: 2 }}>🗺️ Print do mapa <span style={{ fontWeight: 600, color: C.mut, fontSize: 12 }}>(opcional)</span></div>
        <div style={{ fontSize: 12, color: C.mut, marginBottom: 8 }}>Anexe o print da rota do Google Maps para justificar o km rodado. Pode adicionar mais de um (ida/volta, trechos).</div>
        <MapaUploader mapas={v.mapas || []} aoAnexar={anexarMapa} aoRemover={removerMapa} />
      </div>

      {/* Dias */}
      {(v.dias || []).map((d, idx) => {
        const somaDia = (d.itens || []).reduce((a, it) => a + (num(it.valor) || 0), 0);
        return (
          <div key={d.id} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontWeight: 800, color: C.navy }}>Dia {idx + 1}</div>
              <button onClick={() => delDia(d.id)} style={{ border: "none", background: "none", color: C.red, fontWeight: 800, cursor: "pointer", fontSize: 13 }}>remover dia</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 10 }}>
              <Campo rotulo="Data" type="date" value={d.data} onChange={(e) => setDia(d.id, { data: e.target.value })} />
              <Campo rotulo="Km rodado no dia" sufixo="km" inputMode="decimal" value={d.km} onChange={(e) => setDia(d.id, { km: e.target.value })} placeholder="Ex.: 240" />
            </div>

            {(d.itens || []).map((it) => {
              const ti = tipoInfo(it.tipo);
              return (
                <div key={it.id} style={{ background: C.grayBg, borderRadius: 10, padding: 10, marginTop: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontWeight: 700, color: C.ink }}>{ti.ico} {ti.rot}</span>
                    <button onClick={() => delItem(d.id, it.id)} style={{ border: "none", background: "none", color: C.red, fontWeight: 800, cursor: "pointer" }}>×</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: it.tipo === "combustivel" ? "1fr 1fr" : "1fr", gap: 8 }}>
                    <Campo rotulo="Valor" sufixo="R$" inputMode="decimal" value={it.valor} onChange={(e) => setItem(d.id, it.id, { valor: e.target.value })} />
                    {it.tipo === "combustivel" && <Campo rotulo="Litros" sufixo="L" inputMode="decimal" value={it.litros} onChange={(e) => setItem(d.id, it.id, { litros: e.target.value })} />}
                  </div>
                  {it.tipo === "combustivel" && <Campo rotulo="Posto (opcional)" value={it.posto} onChange={(e) => setItem(d.id, it.id, { posto: e.target.value })} />}
                  <div style={{ marginTop: 6 }}>
                    {it.foto
                      ? <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <img src={it.foto.url || it.foto.b64} alt="" style={{ width: 54, height: 54, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}` }} />
                          <span style={{ fontSize: 12, color: it.foto.url ? C.ok : C.mut }}>{it.foto.url ? "Comprovante anexado ✓" : "Enviando…"}</span>
                          <button onClick={() => setItem(d.id, it.id, { foto: null })} style={{ border: "none", background: "none", color: C.red, fontWeight: 800, cursor: "pointer", marginLeft: "auto" }}>trocar</button>
                        </div>
                      : <BotaoComprovante aoAnexar={(foto) => anexar(d.id, it.id, foto)} rotulo="📷 Anexar comprovante" />}
                  </div>
                </div>
              );
            })}

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {TIPOS.map((tp) => (
                <button key={tp.id} onClick={() => addItem(d.id, tp.id)} style={{ fontSize: 12, fontWeight: 700, color: C.navy, background: "#fff", border: `1px solid ${C.line}`, borderRadius: 99, padding: "6px 11px", cursor: "pointer" }}>+ {tp.ico} {tp.rot}</button>
              ))}
            </div>
            {somaDia > 0 && <div style={{ textAlign: "right", fontSize: 12.5, color: C.mut, marginTop: 6 }}>Subtotal do dia: <b style={{ color: C.navy }}>{brl(somaDia)}</b></div>}
          </div>
        );
      })}

      <Btn tom="claro" onClick={addDia} style={{ marginBottom: 12 }}>＋ Adicionar dia</Btn>

      {msg === "ok" && <div style={{ color: C.ok, fontWeight: 700, textAlign: "center", marginBottom: 8 }}>✅ Viagem salva.</div>}
      {msg && msg !== "ok" && <div style={{ color: C.red, fontWeight: 600, fontSize: 13.5, marginBottom: 8 }}>{msg}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Btn tom="claro" onClick={() => salvar(false)} disabled={salvando}>{salvando ? "Salvando…" : "💾 Salvar"}</Btn>
        <Btn tom="ok" onClick={() => salvar(true)} disabled={salvando}>{salvando ? "Salvando…" : "✔ Fechar viagem"}</Btn>
      </div>
    </Cartao>
  );
}

// ============================================================================
// RELATÓRIO DA VIAGEM (PDF)
// ============================================================================
function RelatorioViagem({ viagem: v, perfil, fechar }) {
  const t = totaisViagem(v);
  const comprovantes = [];
  (v.dias || []).forEach((d) => (d.itens || []).forEach((it) => { if (it.foto?.url) comprovantes.push({ ...it.foto, rot: `${fmtBR(d.data)} · ${tipoInfo(it.tipo).rot}` }); }));

  return (
    <Impressao fechar={fechar} nomeArquivo={`despesas-${(v.titulo || "viagem").replace(/\W+/g, "-").slice(0, 24)}.pdf`}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: `3px solid ${C.navy}`, paddingBottom: 10 }}>
        <Logo s={46} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: F.disp, fontWeight: 800, fontSize: 22, color: C.navy }}>SOLOCONTROL</div>
          <div style={{ fontSize: 11, color: C.mut }}>Relatório de despesas de viagem</div>
        </div>
        <div style={{ textAlign: "right", fontSize: 11, color: C.mut }}>
          <div style={{ fontWeight: 800, color: C.ink, fontSize: 13 }}>{v.titulo}</div>
          {fmtBR(v.dataInicio)} → {fmtBR(v.dataFim || v.dataInicio)}
        </div>
      </div>

      <div style={secRel}>Identificação</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
        <tr><td style={tabTd}><b>Funcionário:</b> {v.funcNome || perfil.nome}</td><td style={tabTd}><b>Veículo:</b> {v.veiculo || "—"} {v.placa ? `· ${v.placa}` : ""}</td></tr>
        <tr><td style={tabTd}><b>Obra:</b> {v.obraNome || "—"}</td><td style={tabTd}><b>Período:</b> {fmtBR(v.dataInicio)} a {fmtBR(v.dataFim || v.dataInicio)} ({t.diasCount} dia(s))</td></tr>
      </tbody></table>

      {/* Painel de indicadores */}
      <div style={secRel}>Indicadores</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {[
          ["Total geral", brl(t.totalGeral)],
          ["Km rodado", `${nfmt(t.kmTotal, 0)} km`],
          ["Custo por km", t.custoPorKm != null ? `${brl(t.custoPorKm)}/km` : "—"],
          ["Combustível", brl(t.combustivel)],
          ["Rendimento", t.kmPorLitro != null ? `${nfmt(t.kmPorLitro, 1)} km/L` : "—"],
          ["Preço médio", t.precoMedioLitro != null ? `${brl(t.precoMedioLitro)}/L` : "—"],
        ].map(([k, val]) => (
          <div key={k} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "8px 10px" }}>
            <div style={{ fontSize: 9.5, color: C.mut, textTransform: "uppercase", letterSpacing: 0.4 }}>{k}</div>
            <div style={{ fontWeight: 800, color: C.navy, fontSize: 15 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Tabela diária */}
      <div style={secRel}>Lançamentos por dia</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={tabTh}>Data</th><th style={tabTh}>Km</th><th style={tabTh}>Combustível</th>
          <th style={tabTh}>Pedágio</th><th style={tabTh}>Outras</th><th style={tabTh}>Total dia</th>
        </tr></thead>
        <tbody>
          {(v.dias || []).map((d) => {
            const comb = (d.itens || []).filter((i) => i.tipo === "combustivel").reduce((a, i) => a + (num(i.valor) || 0), 0);
            const ped = (d.itens || []).filter((i) => i.tipo === "pedagio").reduce((a, i) => a + (num(i.valor) || 0), 0);
            const out = (d.itens || []).filter((i) => !["combustivel", "pedagio"].includes(i.tipo)).reduce((a, i) => a + (num(i.valor) || 0), 0);
            const litros = (d.itens || []).filter((i) => i.tipo === "combustivel").reduce((a, i) => a + (num(i.litros) || 0), 0);
            return (
              <tr key={d.id}>
                <td style={tabTd}>{fmtBR(d.data)}</td>
                <td style={tabTd}>{d.km ? `${nfmt(num(d.km), 0)}` : "—"}</td>
                <td style={tabTd}>{comb ? `${brl(comb)}${litros ? ` (${nfmt(litros, 1)} L)` : ""}` : "—"}</td>
                <td style={tabTd}>{ped ? brl(ped) : "—"}</td>
                <td style={tabTd}>{out ? brl(out) : "—"}</td>
                <td style={{ ...tabTd, fontWeight: 700 }}>{brl(comb + ped + out)}</td>
              </tr>
            );
          })}
          <tr>
            <td style={{ ...tabTd, fontWeight: 800, background: C.grayBg }}>TOTAL</td>
            <td style={{ ...tabTd, fontWeight: 800, background: C.grayBg }}>{nfmt(t.kmTotal, 0)}</td>
            <td style={{ ...tabTd, fontWeight: 800, background: C.grayBg }}>{brl(t.combustivel)}</td>
            <td style={{ ...tabTd, fontWeight: 800, background: C.grayBg }}>{brl(t.pedagio)}</td>
            <td style={{ ...tabTd, fontWeight: 800, background: C.grayBg }}>{brl(t.alimentacao + t.hospedagem + t.outro)}</td>
            <td style={{ ...tabTd, fontWeight: 800, background: C.grayBg }}>{brl(t.totalGeral)}</td>
          </tr>
        </tbody>
      </table>

      {/* Comprovantes */}
      {comprovantes.length > 0 && (
        <>
          <div style={secRel}>Comprovantes anexados</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
            {comprovantes.map((c) => (
              <figure key={c.id} style={{ margin: 0, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", breakInside: "avoid" }}>
                <img src={c.url} alt="" style={{ width: "100%", height: 170, objectFit: "cover", display: "block" }} />
                <figcaption style={{ fontSize: 9, padding: "3px 6px", color: C.mut }}>{c.rot} {c.utm ? `· ${c.utm}` : ""}</figcaption>
              </figure>
            ))}
          </div>
        </>
      )}

      {/* Print(s) do mapa — trajeto (opcional) */}
      {(v.mapas || []).filter((mp) => mp.url).length > 0 && (
        <>
          <div style={secRel}>Trajeto — print do mapa</div>
          <div style={{ display: "grid", gridTemplateColumns: (v.mapas.filter((mp) => mp.url).length > 1 ? "repeat(2, 1fr)" : "1fr"), gap: 8 }}>
            {v.mapas.filter((mp) => mp.url).map((mp) => (
              <figure key={mp.id} style={{ margin: 0, border: `1px solid ${C.line}`, borderRadius: 8, overflow: "hidden", breakInside: "avoid" }}>
                <img src={mp.url} alt="" style={{ width: "100%", maxHeight: 320, objectFit: "contain", display: "block", background: "#fff" }} />
              </figure>
            ))}
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 30, marginTop: 44, breakInside: "avoid" }}>
        {[`${v.funcNome || perfil.nome} — solicitante`, "Coordenação — aprovação"].map((r) => (
          <div key={r} style={{ textAlign: "center" }}><div style={{ borderTop: `1.5px solid ${C.ink}`, paddingTop: 5, fontSize: 11 }}>{r}</div></div>
        ))}
      </div>
      <div style={{ fontSize: 9.5, color: C.mut, marginTop: 16, borderTop: `1px solid ${C.line}`, paddingTop: 6 }}>
        Documento gerado pelo sistema Solocontrol em {fmtDataHora()} · Comprovantes georreferenciados.
      </div>
    </Impressao>
  );
}

// ============================================================================
// PAINEL DA COORDENAÇÃO — todas as viagens (leitura + relatório)
// ============================================================================
export function CoordDespesas({ perfil }) {
  const viagens = useTodasViagens();
  const [rel, setRel] = useState(null);
  const [mes, setMes] = useState(hojeISO().slice(0, 7));
  const doMes = viagens.filter((v) => (v.dataInicio || "").startsWith(mes));
  const totalMes = doMes.reduce((a, v) => a + totaisViagem(v).totalGeral, 0);

  return (
    <>
      <Titulo sub="Despesas de viagem lançadas pela equipe.">Despesas — coordenação</Titulo>
      <Cartao>
        <Campo rotulo="Mês de referência" type="month" value={mes} onChange={(e) => setMes(e.target.value)} />
        <Linha k="Viagens no mês" v={`${doMes.length}`} />
        <Linha k="Total gasto no mês" v={brl(totalMes)} forte />
      </Cartao>

      {!doMes.length && <Cartao><div style={{ color: C.mut, textAlign: "center", padding: 8 }}>Nenhuma viagem neste mês.</div></Cartao>}

      {doMes.map((v) => {
        const t = totaisViagem(v);
        return (
          <Cartao key={v.id}>
            <div style={{ fontWeight: 800, color: C.navy }}>{v.titulo || "Viagem"} <span style={{ fontWeight: 600, color: C.mut, fontSize: 12.5 }}>· {v.funcNome}</span></div>
            <Linha k="Período" v={`${fmtBR(v.dataInicio)} → ${fmtBR(v.dataFim || v.dataInicio)}`} />
            <Linha k="Km · custo/km" v={`${nfmt(t.kmTotal, 0)} km · ${t.custoPorKm != null ? brl(t.custoPorKm) + "/km" : "—"}`} />
            <Linha k="Total" v={brl(t.totalGeral)} forte />
            <Btn cheio={false} onClick={() => setRel(v)} style={{ marginTop: 10, padding: "10px 14px" }}>📄 Relatório</Btn>
          </Cartao>
        );
      })}

      {rel && <RelatorioViagem viagem={rel} perfil={perfil} fechar={() => setRel(null)} />}
    </>
  );
}

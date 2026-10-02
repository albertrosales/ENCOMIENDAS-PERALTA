import express from "express";
import { createClient } from "@base44/sdk";
import { createWorker } from "tesseract.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 10000,
  BASE44_APP_ID,
  BASE44_API_KEY,
  TELEGRAM_BOT_TOKEN,
  PUBLIC_URL,
  ALLOWED_TELEGRAM_IDS = "",
  WHATSAPP_COUNTRY_CODE = "504" // Honduras por defecto
} = process.env;

for (const [name, value] of Object.entries({
  BASE44_APP_ID,
  BASE44_API_KEY,
  TELEGRAM_BOT_TOKEN
})) {
  if (!value) {
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
}

const base44 = createClient({
  appId: BASE44_APP_ID,
  headers: { api_key: BASE44_API_KEY }
});

const allowedIds = new Set(
  ALLOWED_TELEGRAM_IDS.split(",").map(x => x.trim()).filter(Boolean)
);

// Consultar: si no hay lista, cualquiera puede consultar (igual que antes).
function isAuthorized(userId) {
  return allowedIds.size === 0 || allowedIds.has(String(userId));
}

// Marcar entregas: SOLO usuarios que estén en ALLOWED_TELEGRAM_IDS.
function canDeliver(userId) {
  return allowedIds.size > 0 && allowedIds.has(String(userId));
}

/* ------------------------------------------------------------------ */
/*  Telegram                                                           */
/* ------------------------------------------------------------------ */

async function telegram(method, payload) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }
  );
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  }
  return data.result;
}

function send(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra
  });
}

/* ------------------------------------------------------------------ */
/*  Utilidades de formato                                              */
/* ------------------------------------------------------------------ */

const SEP = "━━━━━━━━━━━━━━━━━━";

const ESTADO_EMOJI = {
  registrada: "🟡",
  recibida: "🔵",
  en_transito: "🚚",
  en_sucursal: "🏢",
  en_ruta_entrega: "🛵",
  entregada: "✅",
  cancelada: "❌"
};

function normalizeGuide(input = "") {
  return input.trim().toUpperCase();
}

function prettyEstado(value = "") {
  const map = {
    registrada: "Registrada",
    recibida: "Recibida",
    en_transito: "En tránsito",
    en_sucursal: "En sucursal",
    en_ruta_entrega: "En ruta de entrega",
    entregada: "Entregada",
    cancelada: "Cancelada"
  };
  return map[value] || value || "Sin estado";
}

function prettyPago(value = "") {
  const map = { pendiente: "Pendiente", pagado: "Pagado" };
  return map[value] || value || "Sin dato";
}

function prettyFormaPago(value = "") {
  const map = { efectivo: "Efectivo", transferencia: "Transferencia" };
  return map[value] || value || "Sin dato";
}

function prettyEntrega(value = "") {
  const map = { sucursal: "En sucursal", domicilio: "A domicilio" };
  return map[value] || value || "Sin dato";
}

function money(value) {
  if (value === null || value === undefined || value === "") return "Sin dato";
  const n = Number(value);
  return Number.isFinite(n) ? `L ${n.toFixed(2)}` : String(value);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return null;
}

// "Sucursal Central Tocoa" -> "Tocoa"
function cityOf(value) {
  if (!value) return "Sin dato";
  const clean = String(value).replace(/^sucursal\s+(central\s+)?/i, "").trim();
  return clean || String(value);
}

// "2026-10-02" -> "02/10/2026"
function fmtDate(value) {
  if (!value) return "Sin dato";
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(value);
}

function fmtDateTime(value) {
  if (!value) return "Sin fecha";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("es-HN", {
    timeZone: "America/Tegucigalpa",
    dateStyle: "short",
    timeStyle: "short"
  });
}

/* ------------------------------------------------------------------ */
/*  Teléfono y enlace de WhatsApp                                      */
/* ------------------------------------------------------------------ */

function findPhone(e) {
  const preferred = [
    "telefono_destinatario",
    "telefono",
    "celular",
    "whatsapp",
    "telefono_cliente",
    "phone"
  ];
  for (const key of preferred) {
    if (e[key]) return e[key];
  }
  const key = Object.keys(e).find(k => /tel|cel|whats|phone/i.test(k) && e[k]);
  if (key) return e[key];

  console.warn("Sin teléfono. Campos de la encomienda:", Object.keys(e).join(", "));
  return null;
}

// 8 dígitos -> Honduras (504). Más de 8 -> ya trae código de país.
function toWhatsAppNumber(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  digits = digits.replace(/^00/, "");
  if (digits.length === 8) digits = `${WHATSAPP_COUNTRY_CODE}${digits}`;
  return digits;
}

function buildWhatsAppLink(rawPhone, guia) {
  const number = toWhatsAppNumber(rawPhone);
  if (!number) return null;
  const text = encodeURIComponent(
    `Hola, le escribo sobre su encomienda con guía ${guia}.`
  );
  return `https://wa.me/${number}?text=${text}`;
}

/* ------------------------------------------------------------------ */
/*  Base44                                                             */
/* ------------------------------------------------------------------ */

let loggedFields = false;

async function findEncomiendaByGuia(guia) {
  const Entity = base44.entities.Encomienda;
  let found = null;

  if (typeof Entity.filter === "function") {
    try {
      const result = await Entity.filter({ numero_guia: guia });
      if (Array.isArray(result) && result.length) found = result[0];
    } catch (err) {
      console.warn("filter() no funcionó, probando list({q})");
    }
  }

  if (!found) {
    try {
      const result = await Entity.list({ q: { numero_guia: guia }, limit: 5 });
      if (Array.isArray(result) && result.length) {
        found =
          result.find(x => normalizeGuide(x.numero_guia) === guia) || null;
      }
    } catch (err) {
      console.warn("list({q}) no funcionó, probando list()");
    }
  }

  if (!found) {
    const all = await Entity.list();
    if (Array.isArray(all)) {
      found = all.find(x => normalizeGuide(x.numero_guia) === guia) || null;
    }
  }

  if (found && !loggedFields) {
    loggedFields = true;
    console.log("Campos de Encomienda:", Object.keys(found).join(", "));
  }
  return found;
}

async function findEntregasByEncomiendaId(encomiendaId) {
  const Entity = base44.entities.Entrega;
  const byDate = (a, b) =>
    new Date(b.fecha_hora || b.created_date || 0) -
    new Date(a.fecha_hora || a.created_date || 0);

  if (typeof Entity.filter === "function") {
    try {
      const result = await Entity.filter({ encomienda_id: encomiendaId });
      if (Array.isArray(result)) return result.sort(byDate);
    } catch (err) {
      console.warn("Entrega.filter() no funcionó, probando list({q})");
    }
  }

  try {
    const result = await Entity.list({
      q: { encomienda_id: encomiendaId },
      sort_by: "-fecha_hora",
      limit: 20
    });
    if (Array.isArray(result)) {
      return result.filter(x => x.encomienda_id === encomiendaId);
    }
  } catch (err) {
    console.warn("Entrega.list({q}) no funcionó, probando list()");
  }

  const all = await Entity.list();
  if (!Array.isArray(all)) return [];
  return all.filter(x => x.encomienda_id === encomiendaId).sort(byDate);
}

/* ------------------------------------------------------------------ */
/*  Mensaje de seguimiento                                             */
/* ------------------------------------------------------------------ */

function renderEncomienda(e, entregas = [], phone = null) {
  const estado = String(e.estado || "").toLowerCase();
  const emoji = ESTADO_EMOJI[estado] || "⚪";
  const esc = escapeHtml;

  const remitente = pick(e, ["remitente", "remitente_nombre", "nombre_remitente"]);
  const origen = pick(e, [
    "sucursal_origen",
    "sucursal_origen_nombre",
    "origen",
    "sucursal"
  ]);

  const lines = [
    "📦 <b>Encomiendas Peralta — Seguimiento</b>",
    `N° de guía: <b>${esc(e.numero_guia)}</b>`,
    `Estado: ${emoji} ${esc(prettyEstado(estado))}`,
    SEP,
    `👤 Remitente: ${esc(remitente || "Sin dato")}`,
    `👤 Destinatario: ${esc(e.destinatario || "Sin dato")}`,
    `📱 Teléfono: ${esc(phone || "Sin dato")}`,
    SEP,
    `📍 Origen: ${esc(cityOf(origen))}`,
    `📍 Destino: ${esc(e.destino || "Sin dato")}`,
    `📦 Paquete: ${esc(e.tipo_paquete || "Sin dato")} — ${esc(e.peso ?? "?")} lb`,
    `🏠 Entrega: ${esc(prettyEntrega(e.tipo_entrega))}`,
    SEP,
    `💰 Total: ${esc(money(e.precio))}`,
    `💵 Pago: ${esc(prettyFormaPago(e.forma_pago))}`,
    `⏳ Estado de pago: ${esc(prettyPago(e.estado_pago))}`,
    SEP,
    `📅 Fecha: ${esc(fmtDate(e.fecha))}`
  ];

  if (e.observaciones) {
    lines.push(`📝 Observación: ${esc(e.observaciones)}`);
  }

  lines.push(SEP);

  if (entregas.length) {
    const d = entregas[0];
    lines.push(
      "✅ <b>Última entrega</b>",
      `🕒 ${esc(fmtDateTime(d.fecha_hora || d.created_date))}`,
      `🙋 Recibió: ${esc(d.persona_recibe || "Sin dato")}`
    );
    if (d.observaciones) lines.push(`📝 ${esc(d.observaciones)}`);
  } else if (estado === "registrada") {
    lines.push("🚚 <b>Envío pendiente</b>", "Aún no se registran entregas.");
  } else if (estado === "en_transito") {
    lines.push(
      `🚚 <b>En tránsito hacia ${esc(e.destino || "destino")}</b>`,
      "Aún no se registran entregas."
    );
  } else {
    lines.push("Aún no se registran entregas.");
  }

  return lines.join("\n");
}

function trackingKeyboard(e, waLink) {
  const rows = [];
  if (waLink) {
    const name = String(e.destinatario || "destinatario").slice(0, 30);
    rows.push([{ text: `💬 Abrir WhatsApp de ${name}`, url: waLink }]);
  }
  const estado = String(e.estado || "").toLowerCase();
  if (estado !== "entregada" && estado !== "cancelada") {
    rows.push([
      { text: "✅ Marcar como entregada", callback_data: `ent:${e.numero_guia}` }
    ]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

async function sendTracking(chatId, guia) {
  const e = await findEncomiendaByGuia(guia);
  if (!e) {
    await send(chatId, `❌ No encontré la guía <b>${escapeHtml(guia)}</b>.`);
    return null;
  }
  const entregas = await findEntregasByEncomiendaId(e.id);
  const phone = findPhone(e);
  const waLink = buildWhatsAppLink(phone, e.numero_guia);

  await send(chatId, renderEncomienda(e, entregas, phone), {
    reply_markup: trackingKeyboard(e, waLink)
  });
  return e;
}

/* ------------------------------------------------------------------ */
/*  Lectura de la guía desde una foto (OCR gratuito con Tesseract)     */
/* ------------------------------------------------------------------ */

let ocrWorkerPromise = null;

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- "
      });
      return worker;
    })();
  }
  return ocrWorkerPromise;
}

// Devuelve posibles guías (corrige confusiones típicas del OCR)
function guideCandidatesFromText(text = "") {
  const t = text.toUpperCase().replace(/[—–_]/g, "-");
  const m = t.match(/EP\s*-?\s*([0-9OILSB]{8})\s*-?\s*([A-Z0-9]{4})/);
  if (!m) return [];

  const date = m[1]
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8");
  const suffix = m[2];

  const variants = new Set([
    suffix,
    suffix.replace(/O/g, "0"),
    suffix.replace(/0/g, "O")
  ]);
  return [...variants].map(s => `EP-${date}-${s}`);
}

async function readGuidesFromMessagePhoto(message) {
  let fileId = null;
  if (Array.isArray(message.photo) && message.photo.length) {
    fileId = message.photo[message.photo.length - 1].file_id; // la más grande
  } else if (message.document?.mime_type?.startsWith("image/")) {
    fileId = message.document.file_id;
  }
  if (!fileId) return [];

  const info = await telegram("getFile", { file_id: fileId });
  const res = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${info.file_path}`
  );
  const buffer = Buffer.from(await res.arrayBuffer());

  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buffer);
  return guideCandidatesFromText(data.text);
}

/* ------------------------------------------------------------------ */
/*  Marcar como entregada (flujo con confirmación)                     */
/* ------------------------------------------------------------------ */

// Estado temporal por chat. Se pierde si Render reinicia el servicio.
const pending = new Map();

async function askConfirm(chatId, st) {
  st.step = "confirmar";
  const lines = [
    "📋 <b>Confirmar entrega</b>",
    `Guía: <b>${escapeHtml(st.guia)}</b>`,
    `🙋 Recibió: ${escapeHtml(st.persona)}`
  ];
  if (st.pagoPendiente) {
    lines.push(`💵 Pago cobrado: ${st.cobrado ? "Sí" : "No"}`);
  }
  await send(chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Confirmar", callback_data: "ok" },
          { text: "✖ Cancelar", callback_data: "no" }
        ]
      ]
    }
  });
}

async function finalizeDelivery(chatId, st) {
  const e = await findEncomiendaByGuia(st.guia);
  if (!e) {
    pending.delete(chatId);
    await send(chatId, `❌ No encontré la guía <b>${escapeHtml(st.guia)}</b>.`);
    return;
  }

  const estado = String(e.estado || "").toLowerCase();
  if (estado === "entregada") {
    pending.delete(chatId);
    await send(chatId, "ℹ️ Esa encomienda ya estaba marcada como entregada.");
    return;
  }
  if (estado === "cancelada") {
    pending.delete(chatId);
    await send(chatId, "⛔ Esa encomienda está cancelada, no se puede entregar.");
    return;
  }

  try {
    await base44.entities.Entrega.create({
      encomienda_id: e.id,
      fecha_hora: new Date().toISOString(),
      persona_recibe: st.persona
    });
  } catch (err) {
    console.error("No se pudo crear la Entrega:", err);
    await send(
      chatId,
      `⚠️ No pude guardar la entrega: ${escapeHtml(err.message || String(err))}`
    );
    return;
  }

  try {
    const patch = { estado: "entregada" };
    if (st.cobrado) patch.estado_pago = "pagado";
    await base44.entities.Encomienda.update(e.id, patch);
  } catch (err) {
    console.error("No se pudo actualizar la Encomienda:", err);
    await send(
      chatId,
      "⚠️ La entrega se registró, pero no pude cambiar el estado de la encomienda. Revisalo en la app."
    );
    pending.delete(chatId);
    return;
  }

  pending.delete(chatId);
  await send(
    chatId,
    `✅ Encomienda <b>${escapeHtml(e.numero_guia)}</b> marcada como entregada.\n🙋 Recibió: ${escapeHtml(st.persona)}`
  );
  await sendTracking(chatId, e.numero_guia);
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const userId = cb.from?.id;
  const data = cb.data || "";
  if (!chatId || !userId) return;

  if (!canDeliver(userId)) {
    await telegram("answerCallbackQuery", {
      callback_query_id: cb.id,
      text: "No estás autorizado para marcar entregas.",
      show_alert: true
    });
    return;
  }

  await telegram("answerCallbackQuery", { callback_query_id: cb.id });

  if (data.startsWith("ent:")) {
    const guia = normalizeGuide(data.slice(4));
    const e = await findEncomiendaByGuia(guia);
    if (!e) {
      await send(chatId, `❌ No encontré la guía <b>${escapeHtml(guia)}</b>.`);
      return;
    }
    const estado = String(e.estado || "").toLowerCase();
    if (estado === "entregada" || estado === "cancelada") {
      await send(chatId, `ℹ️ La encomienda está ${prettyEstado(estado).toLowerCase()}.`);
      return;
    }
    pending.set(chatId, {
      guia,
      step: "quien",
      pagoPendiente: String(e.estado_pago || "").toLowerCase() === "pendiente",
      persona: null,
      cobrado: false
    });
    await send(
      chatId,
      `🙋 ¿Quién recibió la encomienda <b>${escapeHtml(guia)}</b>?\nEscribí el nombre o /cancelar.`
    );
    return;
  }

  const st = pending.get(chatId);
  if (!st) {
    await send(chatId, "Esa acción ya expiró. Volvé a buscar la guía.");
    return;
  }

  if ((data === "cob:1" || data === "cob:0") && st.step === "cobro") {
    st.cobrado = data === "cob:1";
    await askConfirm(chatId, st);
    return;
  }

  if (data === "ok" && st.step === "confirmar") {
    await finalizeDelivery(chatId, st);
    return;
  }

  if (data === "no") {
    pending.delete(chatId);
    await send(chatId, "Cancelado. No se guardó ningún cambio.");
  }
}

/* ------------------------------------------------------------------ */
/*  Mensajes de texto y fotos                                          */
/* ------------------------------------------------------------------ */

function extractGuide(text = "") {
  const clean = text.trim();
  const command = clean.match(/^\/buscar(?:@\w+)?\s+(.+)$/i);
  if (command) return normalizeGuide(command[1]);
  if (/^[A-Z0-9][A-Z0-9_-]{4,}$/i.test(clean)) return normalizeGuide(clean);
  return null;
}

async function handlePhoto(chatId, message) {
  await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
  await send(chatId, "📷 Leyendo la guía…");

  const candidates = await readGuidesFromMessagePhoto(message);
  if (!candidates.length) {
    await send(
      chatId,
      "No pude leer una guía en la foto. Probá con otra foto de frente, con buena luz y el número bien enfocado (enviada como archivo se ve mejor), o escribí el número."
    );
    return;
  }

  for (const guia of candidates) {
    const e = await findEncomiendaByGuia(guia);
    if (e) {
      await send(chatId, `📷 Guía leída: <b>${escapeHtml(guia)}</b>`);
      await sendTracking(chatId, guia);
      return;
    }
  }

  await send(
    chatId,
    `📷 Leí <b>${escapeHtml(candidates[0])}</b>, pero no existe en el sistema. Si no es correcta, escribila a mano.`
  );
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  const text = message.text || "";
  if (!chatId || !userId) return;

  if (!isAuthorized(userId)) {
    await send(
      chatId,
      "⛔ No estás autorizado para consultar encomiendas.\n\n" +
        `Tu Telegram ID es: ${userId}\n` +
        "El administrador puede agregarlo en ALLOWED_TELEGRAM_IDS.",
      { parse_mode: undefined }
    );
    return;
  }

  // Comandos que reinician cualquier flujo en curso
  if (/^\/(start|cancelar)(?:@\w+)?$/i.test(text)) {
    pending.delete(chatId);
    if (/^\/cancelar/i.test(text)) {
      await send(chatId, "Cancelado.");
      return;
    }
    await send(
      chatId,
      "📦 <b>Encomiendas Peralta</b>\n\n" +
        "Enviame el número de guía, una <b>foto de la guía</b>, o usá:\n" +
        "<code>/buscar EP-20260903-E5F6</code>"
    );
    return;
  }

  // Esperando el nombre de quien recibió
  const st = pending.get(chatId);
  if (st && st.step === "quien" && text) {
    if (!canDeliver(userId)) {
      pending.delete(chatId);
      return;
    }
    st.persona = text.trim().slice(0, 100);
    if (st.pagoPendiente) {
      st.step = "cobro";
      await send(chatId, "💵 El pago figura como <b>Pendiente</b>. ¿Se cobró al entregar?", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Sí, se cobró", callback_data: "cob:1" },
              { text: "No", callback_data: "cob:0" }
            ]
          ]
        }
      });
    } else {
      await askConfirm(chatId, st);
    }
    return;
  }

  // Foto (o imagen enviada como archivo)
  if (message.photo || message.document?.mime_type?.startsWith("image/")) {
    await handlePhoto(chatId, message);
    return;
  }

  const guia = extractGuide(text);
  if (!guia) {
    await send(
      chatId,
      "Escribí el número de guía o enviame una foto de la guía.\n\n" +
        "Ejemplo:\n<code>EP-20260903-E5F6</code>"
    );
    return;
  }

  await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
  await sendTracking(chatId, guia);
}

/* ------------------------------------------------------------------ */
/*  Servidor                                                           */
/* ------------------------------------------------------------------ */

app.get("/", (req, res) => {
  res.type("text").send("Bot de Encomiendas activo");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/telegram", async (req, res) => {
  // Telegram espera una respuesta rápida.
  res.sendStatus(200);

  try {
    const update = req.body;
    if (update?.callback_query) {
      await handleCallback(update.callback_query);
    } else if (update?.message) {
      await handleMessage(update.message);
    }
  } catch (err) {
    console.error("Error procesando Telegram:", err);
  }
});

async function setWebhook() {
  if (!PUBLIC_URL) {
    console.log("PUBLIC_URL no definida; webhook automático omitido.");
    return;
  }

  const url = `${PUBLIC_URL.replace(/\/+$/, "")}/telegram`;

  try {
    const result = await telegram("setWebhook", {
      url,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    });
    console.log("Webhook configurado:", url, result);
  } catch (err) {
    console.error("No se pudo configurar webhook:", err.message);
  }
}

app.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
  await setWebhook();
});

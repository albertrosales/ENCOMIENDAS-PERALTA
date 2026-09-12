import express from "express";
import { createClient } from "@base44/sdk";

const app = express();
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 10000,
  BASE44_APP_ID,
  BASE44_API_KEY,
  TELEGRAM_BOT_TOKEN,
  PUBLIC_URL,
  ALLOWED_TELEGRAM_IDS = ""
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
  headers: {
    api_key: BASE44_API_KEY
  }
});

const allowedIds = new Set(
  ALLOWED_TELEGRAM_IDS
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);

function isAuthorized(userId) {
  return allowedIds.size === 0 || allowedIds.has(String(userId));
}

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
  const map = {
    pendiente: "Pendiente",
    pagado: "Pagado"
  };
  return map[value] || value || "Sin dato";
}

function prettyFormaPago(value = "") {
  const map = {
    efectivo: "Efectivo",
    transferencia: "Transferencia"
  };
  return map[value] || value || "Sin dato";
}

function prettyEntrega(value = "") {
  const map = {
    sucursal: "Sucursal",
    domicilio: "Domicilio"
  };
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

/**
 * Base44 SDK cambia un poco entre versiones.
 * Intentamos primero filter(), luego list({q}), y como último recurso list() + filtro local.
 */
async function findEncomiendaByGuia(guia) {
  const Entity = base44.entities.Encomienda;

  if (typeof Entity.filter === "function") {
    try {
      const result = await Entity.filter({ numero_guia: guia });
      if (Array.isArray(result) && result.length) return result[0];
    } catch (err) {
      console.warn("filter() no funcionó, probando list({q})");
    }
  }

  try {
    const result = await Entity.list({
      q: { numero_guia: guia },
      limit: 5
    });
    if (Array.isArray(result) && result.length) {
      return result.find(
        x => normalizeGuide(x.numero_guia) === guia
      ) || result[0];
    }
  } catch (err) {
    console.warn("list({q}) no funcionó, probando list()");
  }

  const all = await Entity.list();
  if (!Array.isArray(all)) return null;

  return all.find(
    x => normalizeGuide(x.numero_guia) === guia
  ) || null;
}

async function findEntregasByEncomiendaId(encomiendaId) {
  const Entity = base44.entities.Entrega;

  if (typeof Entity.filter === "function") {
    try {
      const result = await Entity.filter({ encomienda_id: encomiendaId });
      if (Array.isArray(result)) {
        return result.sort(
          (a, b) =>
            new Date(b.fecha_hora || b.created_date || 0) -
            new Date(a.fecha_hora || a.created_date || 0)
        );
      }
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

  return all
    .filter(x => x.encomienda_id === encomiendaId)
    .sort(
      (a, b) =>
        new Date(b.fecha_hora || b.created_date || 0) -
        new Date(a.fecha_hora || a.created_date || 0)
    );
}

function renderEncomienda(e, entregas = []) {
  const lines = [
    "📦 <b>ENCOMIENDA</b>",
    "",
    `🔖 <b>Guía:</b> ${escapeHtml(e.numero_guia)}`,
    `👤 <b>Destinatario:</b> ${escapeHtml(e.destinatario)}`,
    `📍 <b>Destino:</b> ${escapeHtml(e.destino)}`,
    `📦 <b>Tipo:</b> ${escapeHtml(e.tipo_paquete)}`,
    `⚖️ <b>Peso:</b> ${escapeHtml(e.peso)}${e.peso !== undefined ? " lb" : ""}`,
    `💰 <b>Precio:</b> ${escapeHtml(money(e.precio))}`,
    `💳 <b>Forma de pago:</b> ${escapeHtml(prettyFormaPago(e.forma_pago))}`,
    `💵 <b>Estado de pago:</b> ${escapeHtml(prettyPago(e.estado_pago))}`,
    `🚚 <b>Tipo de entrega:</b> ${escapeHtml(prettyEntrega(e.tipo_entrega))}`,
    `📌 <b>Estado:</b> ${escapeHtml(prettyEstado(e.estado))}`,
    `📅 <b>Fecha:</b> ${escapeHtml(e.fecha || "Sin dato")}`
  ];

  if (e.observaciones) {
    lines.push("", `📝 <b>Observaciones:</b> ${escapeHtml(e.observaciones)}`);
  }

  if (entregas.length) {
    const d = entregas[0];
    lines.push(
      "",
      "✅ <b>Último registro de entrega</b>",
      `🕒 ${escapeHtml(d.fecha_hora || d.created_date || "Sin fecha")}`,
      `🙋 <b>Recibió:</b> ${escapeHtml(d.persona_recibe || "Sin dato")}`
    );
    if (d.observaciones) {
      lines.push(`📝 ${escapeHtml(d.observaciones)}`);
    }
  }

  return lines.join("\n");
}

function extractGuide(text = "") {
  const clean = text.trim();

  // /buscar EP-20260903-E5F6
  const command = clean.match(/^\/buscar(?:@\w+)?\s+(.+)$/i);
  if (command) return normalizeGuide(command[1]);

  // Si el usuario envía solamente una guía
  if (/^[A-Z0-9][A-Z0-9_-]{4,}$/i.test(clean)) {
    return normalizeGuide(clean);
  }

  return null;
}

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
    const message = req.body?.message;
    if (!message) return;

    const chatId = message.chat?.id;
    const userId = message.from?.id;
    const text = message.text || "";

    if (!chatId || !userId) return;

    if (!isAuthorized(userId)) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "⛔ No estás autorizado para consultar encomiendas.\n\n" +
          `Tu Telegram ID es: ${userId}\n` +
          "El administrador puede agregarlo en ALLOWED_TELEGRAM_IDS."
      });
      return;
    }

    if (/^\/start(?:@\w+)?$/i.test(text)) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "📦 <b>Encomiendas</b>\n\n" +
          "Envíame el número de guía directamente o usa:\n" +
          "<code>/buscar EP-20260903-E5F6</code>",
        parse_mode: "HTML"
      });
      return;
    }

    const guia = extractGuide(text);

    if (!guia) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text:
          "Escribe el número de guía.\n\n" +
          "Ejemplo:\n" +
          "<code>EP-20260903-E5F6</code>\n\n" +
          "o\n\n" +
          "<code>/buscar EP-20260903-E5F6</code>",
        parse_mode: "HTML"
      });
      return;
    }

    await telegram("sendChatAction", {
      chat_id: chatId,
      action: "typing"
    });

    const encomienda = await findEncomiendaByGuia(guia);

    if (!encomienda) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: `❌ No encontré la guía <b>${escapeHtml(guia)}</b>.`,
        parse_mode: "HTML"
      });
      return;
    }

    const entregas = await findEntregasByEncomiendaId(encomienda.id);

    await telegram("sendMessage", {
      chat_id: chatId,
      text: renderEncomienda(encomienda, entregas),
      parse_mode: "HTML"
    });
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
      allowed_updates: ["message"],
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

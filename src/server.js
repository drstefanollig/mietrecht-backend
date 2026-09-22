/**
 * Miet- & WEG-Recht – Backend v6
 * Nachrichten aus echten Quellen (RSS + Originallink), Redis Cache, Push, Cron 09:00 Uhr
 * Stand: 2026-09-22
 */

const express   = require("express");
const cors      = require("cors");
const webpush   = require("web-push");
const cron      = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk");
const { fetchCandidates, fetchArticleText } = require("./sources");

const app  = express();
const PORT = process.env.PORT || 3000;

app.set("etag", false);
app.use(cors({ origin: "*" }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── VAPID Setup ───────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(
    "mailto:info@capera-immobilien.de",
    VAPID_PUBLIC,
    VAPID_PRIVATE
  );
  console.log("[VAPID] Keys gesetzt ✓");
} else {
  console.warn("[VAPID] Keys fehlen – Push deaktiviert.");
}

// ── Upstash Redis ─────────────────────────────────────────────────────────────
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || null;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || null;

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res  = await fetch(`${REDIS_URL}`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify(["GET", key])
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch(e) { console.warn("[REDIS] GET Fehler:", e.message); return null; }
}

async function redisSet(key, value, ttlSeconds) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    // Upstash REST: ["SET", key, value] oder ["SET", key, value, "EX", ttl]
    const cmd = ttlSeconds
      ? ["SET", key, JSON.stringify(value), "EX", ttlSeconds]
      : ["SET", key, JSON.stringify(value)];
    const res = await fetch(`${REDIS_URL}`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify(cmd)
    });
    const data = await res.json();
    if (data.error) console.warn("[REDIS] SET Fehler:", data.error);
  } catch(e) { console.warn("[REDIS] SET Fehler:", e.message); }
}

// ── Cache + Subscriptions ─────────────────────────────────────────────────────
let cache      = { date: null, news: [], titles: [] };
let subs       = [];
let titleHistory = []; // persistente Titelhistorie über mehrere Tage
let urlHistory   = []; // bereits gemeldete Originallinks – werden nicht erneut ausgewählt

// Beim Start: Cache und Subscriptions aus Redis laden BEVOR Server startet
async function initFromRedis() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn("[INIT] Kein Redis – Cache nicht persistent!");
    return;
  }
  // Cache laden
  const savedCache = await redisGet("mietrecht_cache");
  if (!savedCache) {
    console.log("[INIT] Kein Cache in Redis.");
  } else {
    const today = new Date().toLocaleDateString("sv-SE");
    if (savedCache.date === today && Array.isArray(savedCache.news) && savedCache.news.length > 0) {
      cache = savedCache;
      console.log(`[INIT] Cache: ${cache.news.length} Nachrichten für ${cache.date} ✓`);
    } else {
      console.log(`[INIT] Cache veraltet (${savedCache.date}).`);
    }
  }
  // Titelhistorie laden
  const savedHistory = await redisGet("mietrecht_title_history_v2");
  if (savedHistory && Array.isArray(savedHistory)) {
    titleHistory = savedHistory;
    console.log(`[INIT] Titelhistorie: ${titleHistory.length} Einträge geladen ✓`);
  }
  const savedUrls = await redisGet("mietrecht_url_history");
  if (savedUrls && Array.isArray(savedUrls)) {
    urlHistory = savedUrls;
    console.log(`[INIT] URL-Historie: ${urlHistory.length} Einträge geladen ✓`);
  }
  // Subscriptions laden
  const savedSubs = await redisGet("mietrecht_subs");
  if (savedSubs && Array.isArray(savedSubs)) {
    subs = savedSubs;
    console.log(`[INIT] Subscriptions: ${subs.length} Subscriber geladen ✓`);
  } else {
    console.log("[INIT] Keine Subscriptions in Redis.");
  }
}

async function saveNews(date, news) {
  await redisSet(`mietrecht_archive_${date}`, news, 2592000); // 30 Tage Archiv
  if (date === new Date().toLocaleDateString("sv-SE")) {
    cache = { date, news, titles: news.map(n => n.titel) };
    await redisSet("mietrecht_cache", cache, 604800); // 7 Tage TTL
  }
}

async function saveHistory(news) {
  titleHistory = [...titleHistory, ...news.map(n => n.titel)].slice(-150);
  urlHistory   = [...urlHistory,   ...news.map(n => n.url)].slice(-500);
  await redisSet("mietrecht_title_history_v2", titleHistory, 2592000); // 30 Tage TTL
  await redisSet("mietrecht_url_history",   urlHistory,   5184000); // 60 Tage TTL
  console.log(`[HISTORY] ${titleHistory.length} Titel, ${urlHistory.length} Links gespeichert.`);
}

async function saveSubs() {
  await redisSet("mietrecht_subs", subs); // kein TTL – Subscriptions bleiben dauerhaft
  console.log(`[SUBS] ${subs.length} Subscriber in Redis gespeichert.`);
}

function cacheValid(today) {
  return cache.date === today && hasSources(cache.news);
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
const KATEGORIEN = ["urteil", "gesetz", "markt", "beratung", "politik"];

function cleanText(val, maxLen) {
  if (typeof val !== "string") return "";
  return val.replace(/<[^>]+>/g, "").trim().slice(0, maxLen);
}

// Meldungen ohne Originallink stammen aus der früheren, quellenlosen Generierung
function hasSources(news) {
  return Array.isArray(news) && news.some(n => n && typeof n.url === "string" && n.url.startsWith("http"));
}

function extractJsonArray(text) {
  const raw = text.replace(/```json|```/g, "").trim();
  const s = raw.indexOf("[");
  if (s === -1) return null;
  let depth = 0, inString = false;
  for (let i = s; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {                       // Klammern in Texten (z. B. "Urteil [BGH]") nicht zählen
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(s, i + 1));
    }
  }
  return null;
}

// ── News aus echten Quellen erstellen ─────────────────────────────────────────
// Claude wählt nur aus und fasst zusammen – Link, Quelle und Datum kommen aus dem Feed.
async function fetchNews(date) {
  const candidates = await fetchCandidates(date, { excludeUrls: new Set(urlHistory) });
  if (candidates.length === 0) throw new Error("Keine aktuellen Quellen gefunden");

  const texts = await Promise.all(candidates.map(c => fetchArticleText(c.link)));
  const sourceBlock = candidates.map((c, i) =>
    `[${i + 1}] Quelle: ${c.source} | veröffentlicht: ${c.published.toISOString().slice(0, 10)}\n` +
    `Titel: ${c.title}\n` +
    `Text: ${texts[i] || c.description || "(nur Titel verfügbar)"}`
  ).join("\n\n");

  const recentTitles = titleHistory.slice(-15);
  const recentBlock = recentTitles.length > 0
    ? "\n\nKürzlich bereits gemeldet – diese Themen nicht erneut aufgreifen:\n" + recentTitles.map(t => `- ${t}`).join("\n")
    : "";

  const systemPrompt =
    `Du bist Redakteur der App "Miet- & WEG-Recht" für Vermieter, Mieter, WEG-Verwalter und Eigentümer in Deutschland.
Du erhältst nummerierte, echte Artikel. Wähle bis zu 5 Artikel aus, die für Mietrecht, WEG-Recht oder Immobilienverwaltung am relevantesten sind, und fasse sie zusammen.

REGELN:
- Verwende ausschließlich Informationen aus dem Text des jeweiligen Artikels. Erfinde nichts: keine Aktenzeichen, Daten, Zahlen, Gerichte oder Zitate, die dort nicht stehen.
- Bevorzuge Gerichtsentscheidungen und Gesetzgebung vor Markt- und Branchenmeldungen, und Primär- und Fachquellen (BGH, Haufe, LTO, beck-aktuell) vor Ratgeber- und Boulevardportalen.
- Keine zwei Artikel zum selben Thema. Lieber weniger als 5 als unpassende Artikel (Büro-/Gewerbe-Investment, Podcasts, Preisverleihungen, Personalien weglassen).
- Formuliere eigenständig, übernimm keine Sätze wörtlich.
- "aktenzeichen" nur, wenn es wörtlich im Artikeltext steht, sonst leerer String.

Antworte NUR mit einem JSON-Array, ohne Markdown:
[{"nr":1,"titel":"max. 12 Wörter","zusammenfassung":"2 prägnante Sätze","details":"max. 80 Wörter mit den wichtigsten Fakten","kategorie":"urteil|gesetz|markt|beratung|politik","relevanz":"hoch|mittel","tags":["Tag1","Tag2"],"aktenzeichen":""}]${recentBlock}`;

  console.log(`[${new Date().toISOString()}] API-Aufruf für ${date} mit ${candidates.length} Quellen...`);

  const msg = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 3000,
    system:     systemPrompt,
    messages:   [{ role: "user", content: `Artikel (Stand ${date}):\n\n${sourceBlock}` }]
  });

  const textBlock = msg.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("Kein Text-Block");
  const parsed = extractJsonArray(textBlock.text);
  if (!Array.isArray(parsed)) {
    console.error("[PARSE] Rohantwort:", textBlock.text.slice(0, 500));
    throw new Error("Kein JSON-Array");
  }

  const used = new Set();
  const news = [];
  for (const n of parsed) {
    const idx = Number(n && n.nr) - 1;
    const c = candidates[idx];
    if (!c || used.has(idx) || news.length >= 5) continue;
    used.add(idx);
    const text = texts[idx] || c.description;
    const az = cleanText(n.aktenzeichen, 40);
    news.push({
      id:              `${date}_${news.length + 1}`,
      titel:           cleanText(n.titel, 160) || c.title,
      zusammenfassung: cleanText(n.zusammenfassung, 400),
      details:         cleanText(n.details, 900),
      kategorie:       KATEGORIEN.includes(n.kategorie) ? n.kategorie : "markt",
      relevanz:        n.relevanz === "hoch" ? "hoch" : "mittel",
      tags:            Array.isArray(n.tags) ? n.tags.slice(0, 4).map(t => cleanText(t, 30)).filter(Boolean) : [],
      quelle:          az && text.includes(az) ? `${c.source} · ${az}` : c.source,
      url:             c.link,
      veroeffentlicht: c.published.toISOString().slice(0, 10),
      datum:           date,
      isMock:          false
    });
  }
  if (news.length === 0) throw new Error("Keine verwertbare Auswahl");

  await saveNews(date, news);
  await saveHistory(news);

  console.log(`[${new Date().toISOString()}] OK – ${news.length} Nachrichten mit Quelle gespeichert.`);
  return news;
}

// Parallele Anfragen für denselben Tag teilen sich einen Abruf
const inflight = new Map();
function fetchNewsOnce(date) {
  if (!inflight.has(date)) {
    inflight.set(date, fetchNews(date).finally(() => inflight.delete(date)));
  }
  return inflight.get(date);
}

// ── Push senden ───────────────────────────────────────────────────────────────
async function sendPush(news) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log("[PUSH] Übersprungen – VAPID-Keys nicht gesetzt.");
    return;
  }
  if (subs.length === 0) {
    console.log("[PUSH] Keine Subscriber.");
    return;
  }

  const payload = JSON.stringify({
    title: "§ Miet- & WEG-Recht – " + new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "long" }),
    body:  news[0].titel + "\n\nJetzt lesen – Dein CAPERA News-Team",
    icon:  "/icon-192.png",
    badge: "/badge-96.png",
    tag:   "mietrecht-daily",
    data:  { url: "/" }
  });

  console.log(`[PUSH] Sende an ${subs.length} Subscriber...`);
  const failed = [];

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      console.warn("[PUSH] Fehler:", err.statusCode);
      if (err.statusCode === 404 || err.statusCode === 410) failed.push(sub.endpoint);
    }
  }));

  if (failed.length > 0) {
    subs = subs.filter(s => !failed.includes(s.endpoint));
    await saveSubs();
    console.log(`[PUSH] ${failed.length} abgelaufene Subscriptions entfernt.`);
  }
  console.log("[PUSH] Fertig.");
}

// ── Cron: täglich 09:00 Uhr Europe/Berlin ────────────────────────────────────
let cronRunning = false; // verhindert parallele Ausführung

cron.schedule("0 9 * * *", async () => {
  if (cronRunning) {
    console.log("[CRON] Bereits aktiv – übersprungen.");
    return;
  }
  cronRunning = true;
  const today = new Date().toLocaleDateString("sv-SE");
  console.log(`[CRON] Täglicher Job für ${today}`);

  try {
    // Redis nochmal prüfen – falls anderer Prozess bereits geladen hat
    const saved = await redisGet("mietrecht_cache");
    if (saved && saved.date === today && hasSources(saved.news)) {
      cache = saved;
      console.log("[CRON] Cache aus Redis geladen – sende Push.");
      await sendPush(cache.news);
      return;
    }

    // Neu laden
    const news = await fetchNewsOnce(today);
    await sendPush(news);
  } catch (err) {
    console.error("[CRON] Fehler:", err.message);
    // Falls Cache trotzdem gefüllt wurde: Push noch senden
    if (cacheValid(today)) {
      console.log("[CRON] Sende Push trotz Fehler mit vorhandenem Cache.");
      await sendPush(cache.news);
    }
  } finally {
    cronRunning = false;
  }
}, { timezone: "Europe/Berlin" });

// ── Hilfsfunktion: News für ein bestimmtes Datum holen (Cache → Archiv → Generieren) ──
const ARCHIVE_LIMIT_DAYS = 30;

async function getNewsForDate(date) {
  const today = new Date().toLocaleDateString("sv-SE");

  // Zukunft ablehnen
  if (date > today) return null;

  // Maximales Archivfenster prüfen
  const msPerDay   = 86400000;
  const diffDays   = Math.round((new Date(today) - new Date(date)) / msPerDay);
  if (diffDays > ARCHIVE_LIMIT_DAYS) return null;

  // Memory-Cache (nur für heute relevant)
  if (date === today && cacheValid(today)) {
    console.log(`[API] Memory-Cache Hit für ${date}`);
    return { news: cache.news, cached: true };
  }

  // Redis-Archiv prüfen
  const archiveKey = `mietrecht_archive_${date}`;
  const archived   = await redisGet(archiveKey);
  // Heute ohne Originallinks (frühere Generierung) → neu erstellen; ältere Tage bleiben unverändert
  if (Array.isArray(archived) && archived.length > 0 && (date !== today || hasSources(archived))) {
    console.log(`[API] Archiv-Cache Hit für ${date}`);
    if (date === today) cache = { date, news: archived, titles: archived.map(n => n.titel) };
    return { news: archived, cached: true };
  }

  // Noch nicht vorhanden → generieren
  console.log(`[API] Generiere für ${date}...`);
  const news = await fetchNewsOnce(date);
  return { news, cached: false };
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.get("/api/news", async (req, res) => {
  const today = new Date().toLocaleDateString("sv-SE");
  try {
    const result = await getNewsForDate(today);
    if (!result) return res.status(503).json({ error: "Nachrichten nicht verfügbar." });
    res.json({ ...result, date: today });
  } catch (err) {
    console.error("[FEHLER]", err.message);
    if (cache.news.length > 0) {
      return res.json({ news: cache.news, cached: true, stale: true, date: cache.date });
    }
    res.status(503).json({ error: "Nachrichten nicht verfügbar. Bitte erneut versuchen." });
  }
});

app.get("/api/news/:date", async (req, res) => {
  const date = req.params.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Ungültiges Datumsformat. Erwartet: YYYY-MM-DD" });
  }
  try {
    const result = await getNewsForDate(date);
    if (!result) {
      return res.status(404).json({ error: `Keine Nachrichten für ${date}. Archiv reicht max. ${ARCHIVE_LIMIT_DAYS} Tage zurück.` });
    }
    res.json({ ...result, date });
  } catch (err) {
    console.error(`[FEHLER] Archiv ${date}:`, err.message);
    res.status(503).json({ error: "Nachrichten nicht verfügbar. Bitte erneut versuchen." });
  }
});

app.get("/api/archive", async (req, res) => {
  const today    = new Date().toLocaleDateString("sv-SE");
  const msPerDay = 86400000;
  const dates    = [];
  for (let i = 0; i < ARCHIVE_LIMIT_DAYS; i++) {
    const d = new Date(new Date(today) - i * msPerDay).toLocaleDateString("sv-SE");
    dates.push(d);
  }
  // Parallel prüfen welche Tage Nachrichten mit Originallink haben
  const checks = await Promise.all(
    dates.map(async d => {
      const data = await redisGet(`mietrecht_archive_${d}`);
      return hasSources(data) ? d : null;
    })
  );
  res.json({ available: checks.filter(Boolean) });
});

app.post("/api/subscribe", async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "Ungültige Subscription" });
  if (!subs.find(s => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    await saveSubs();
    console.log(`[SUBS] Neuer Subscriber. Gesamt: ${subs.length}`);
  }
  res.json({ ok: true, total: subs.length });
});

app.post("/api/unsubscribe", async (req, res) => {
  const { endpoint } = req.body;
  subs = subs.filter(s => s.endpoint !== endpoint);
  await saveSubs();
  res.json({ ok: true });
});

app.get("/api/vapid-key", (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.get("/health", (req, res) => {
  const today = new Date().toLocaleDateString("sv-SE");
  res.json({
    status:      "ok",
    cacheDate:   cache.date,
    cacheValid:  cacheValid(today),
    cacheSize:   cache.news.length,
    subscribers: subs.length,
    redis:       (REDIS_URL && REDIS_TOKEN) ? "✓ konfiguriert" : "✗ FEHLT",
    vapid:       VAPID_PUBLIC ? "✓" : "✗ FEHLT (Push deaktiviert)",
    apiKey:      process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT",
    uptime:      Math.floor(process.uptime()) + "s"
  });
});

// Server erst starten nachdem Redis geladen ist
initFromRedis().then(() => {
  app.listen(PORT, () => {
    console.log(`Miet- & WEG-Recht Backend v6 auf Port ${PORT}`);
    console.log(`API-Key:  ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT"}`);
    console.log(`Redis:    ${(REDIS_URL && REDIS_TOKEN) ? "✓ konfiguriert" : "✗ FEHLT"}`);
    console.log(`VAPID:    ${VAPID_PUBLIC ? "✓" : "✗ FEHLT – Push deaktiviert"}`);
    console.log(`Cron:     täglich 09:00 Uhr Europe/Berlin`);
  });
}).catch(err => {
  console.error("[INIT] Fehler beim Start:", err.message);
  // Server trotzdem starten
  app.listen(PORT, () => {
    console.log(`Miet- & WEG-Recht Backend v6 auf Port ${PORT} (ohne Redis-Init)`);
  });
});

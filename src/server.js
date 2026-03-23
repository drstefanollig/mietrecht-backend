/**
// Stand: 2026-03-22
 * Mietrecht News – Backend v5 Final
 * Redis Cache + Push-Notifications + Cron 09:00 Uhr
 */

const express   = require("express");
const cors      = require("cors");
const webpush   = require("web-push");
const cron      = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 3000;

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
    const res  = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch(e) { console.warn("[REDIS] GET Fehler:", e.message); return null; }
}

async function redisSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/set/${key}/ex/90000`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify(JSON.stringify(value))
    });
  } catch(e) { console.warn("[REDIS] SET Fehler:", e.message); }
}

// ── Cache + Subscriptions ─────────────────────────────────────────────────────
let cache = { date: null, news: [], titles: [] };
let subs  = [];

(async function loadCache() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn("[CACHE] Kein Redis – Cache nicht persistent!");
    return;
  }
  const saved = await redisGet("mietrecht_cache");
  if (!saved) { console.log("[CACHE] Kein Cache in Redis."); return; }
  const today = new Date().toLocaleDateString("sv-SE");
  if (saved.date === today && Array.isArray(saved.news) && saved.news.length > 0) {
    cache = saved;
    console.log(`[CACHE] ${cache.news.length} Nachrichten für ${cache.date} aus Redis geladen ✓`);
  } else {
    console.log(`[CACHE] Redis-Cache veraltet (${saved.date}).`);
  }
})();

(async function loadSubs() {
  const saved = await redisGet("mietrecht_subs");
  if (saved && Array.isArray(saved)) {
    subs = saved;
    console.log(`[SUBS] ${subs.length} Subscriber geladen.`);
  }
})();

async function saveCache() {
  await redisSet("mietrecht_cache", cache);
}

async function saveSubs() {
  await redisSet("mietrecht_subs", subs);
}

function cacheValid(today) {
  return cache.date === today && cache.news.length > 0;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function stripTags(val) {
  if (typeof val !== "string") return val;
  return val.replace(/<[^>]+>/g, "").trim();
}

function getKnownTitles() {
  return (cache.titles || []).slice(-20);
}

// ── News von Claude holen ─────────────────────────────────────────────────────
async function fetchNews(date) {
  const known = getKnownTitles();
  const exclusionBlock = known.length > 0
    ? "\n\nBEREITS BERICHTET (nicht wiederholen):\n"
      + known.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "";

  const systemPrompt =
    `Du bist Rechtsredakteur für deutsches Mietrecht. Recherchiere 5 aktuelle Nachrichten für ${date} aus UNTERSCHIEDLICHEN Themenbereichen.

GERICHTSURTEILE (mindestens 3 der 5 Nachrichten):
Suche aktiv nach aktuellen Urteilen von: BGH, OLG (alle Bundesländer), LG (alle großen Städte), AG (Amtsgerichte: AG München, AG Berlin-Mitte, AG Hamburg, AG Köln, AG Frankfurt, AG Stuttgart, AG Düsseldorf, AG Leipzig, AG Bremen, AG Hannover).
Themen: Kündigung, Kaution, Betriebskosten, Schönheitsreparaturen, Mietminderung, Eigenbedarfskündigung, Nebenkostenabrechnung, Schimmel, Lärmbelästigung, Tierhaltung, Untervermietung, Modernisierung, Ruhestörung, Wohnungsabnahmen und -übergaben.

WEITERE QUELLEN für die restlichen 3 Nachrichten:
Gesetzgebung: Bundesjustizministerium, Bundesbauministerium, Bundesrat, Bundestag, EU-Kommission
Verbände: Deutscher Mieterbund, Haus & Grund, GdW, IVD, BRAK, vzbv
Markt/Statistik: Statistisches Bundesamt, IW Köln, Institut Wohnen und Umwelt, KfW, Empirica, JLL, CBRE
Fachmedien: Haufe Mietrecht, NJW, NZM, ZMR, Grundeigentum, Immobilien Zeitung
Verbraucher: Verbraucherzentrale, Stiftung Warentest, dpa

PFLICHTREGELN:
- Jede der 5 Nachrichten MUSS ein anderes Thema UND eine andere Quelle haben
- Keine zwei Urteile zum gleichen Rechtsproblem
- Keine allgemeinen Überblicksartikel – nur konkrete Einzelereignisse mit Datum, Aktenzeichen oder Fundstelle
${exclusionBlock}

Antworte NUR mit JSON-Array, kein Markdown, keine XML-Tags, keine <cite>-Tags:
[{"id":"${date}_1","titel":"max 12 Wörter","zusammenfassung":"2 prägnante Sätze mit konkreten Fakten","details":"max 80 Wörter, Aktenzeichen wenn vorhanden","kategorie":"urteil|gesetz|markt|beratung|politik","relevanz":"hoch|mittel","tags":["T1","T2"],"quelle":"Gericht/Institution + Aktenzeichen","url":"https://url-oder-leerer-string","datum":"${date}"}]`;

  console.log(`[${new Date().toISOString()}] API-Aufruf für ${date}...`);

  let msg;
  try {
    msg = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 3000,
      tools:      [{ type: "web_search_20250305", name: "web_search" }],
      system:     systemPrompt,
      messages:   [{ role: "user", content: `5 Mietrecht-Nachrichten ${date}. Nur JSON.` }]
    });
    console.log("[API] Mit Web Search OK");
  } catch (e) {
    console.warn("[API] Web Search Fallback:", e.message);
    msg = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 3000,
      system:     systemPrompt,
      messages:   [{ role: "user", content: `5 Mietrecht-Nachrichten ${date}. Nur JSON.` }]
    });
  }

  const textBlock = msg.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("Kein Text-Block");

  let raw = textBlock.text.replace(/```json|```/g, "").trim();
  const s = raw.indexOf("[");
  let e = -1;
  if (s !== -1) {
    let depth = 0;
    for (let i = s; i < raw.length; i++) {
      if (raw[i] === "[" || raw[i] === "{") depth++;
      else if (raw[i] === "]" || raw[i] === "}") {
        depth--;
        if (depth === 0 && raw[i] === "]") { e = i; break; }
      }
    }
  }
  if (s === -1 || e === -1) {
    console.error("[PARSE] Rohantwort:", raw.slice(0, 500));
    throw new Error("Kein JSON-Array");
  }
  raw = raw.slice(s, e + 1);

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Leeres Array");

  const news = parsed.map((n, i) => ({
    ...n,
    titel:           stripTags(n.titel),
    zusammenfassung: stripTags(n.zusammenfassung),
    details:         stripTags(n.details),
    quelle:          stripTags(n.quelle),
    url:             (typeof n.url === "string" && n.url.startsWith("http")) ? n.url : null,
    datum:           date,
    id:              `${date}_${i + 1}`,
    isMock:          false
  }));

  cache = { date, news, titles: news.map(n => n.titel) };
  await saveCache();

  console.log(`[${new Date().toISOString()}] OK – ${news.length} Nachrichten in Redis gespeichert.`);
  return news;
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
    title: "Capera Mietrecht News – " + new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "long" }),
    body:  news[0].titel + "\n\nJetzt lesen – Dein CAPERA News-Team",
    icon:  "/icon-192.png",
    badge: "/icon-192.png",
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
cron.schedule("0 9 * * *", async () => {
  const today = new Date().toLocaleDateString("sv-SE");
  console.log(`[CRON] Täglicher Job für ${today}`);
  if (cacheValid(today)) {
    console.log("[CRON] Cache vorhanden – nur Push.");
    await sendPush(cache.news);
    return;
  }
  try {
    const news = await fetchNews(today);
    await sendPush(news);
  } catch (err) {
    console.error("[CRON] Fehler:", err.message);
  }
}, { timezone: "Europe/Berlin" });

// ── REST API ──────────────────────────────────────────────────────────────────

app.get("/api/news", async (req, res) => {
  const today = new Date().toLocaleDateString("sv-SE");

  if (cacheValid(today)) {
    console.log(`[API] Memory-Cache Hit für ${today}`);
    return res.json({ news: cache.news, cached: true, date: today });
  }

  const saved = await redisGet("mietrecht_cache");
  if (saved && saved.date === today && Array.isArray(saved.news) && saved.news.length > 0) {
    cache = saved;
    console.log(`[API] Redis-Cache Hit für ${today}`);
    return res.json({ news: cache.news, cached: true, date: today });
  }

  try {
    const news = await fetchNews(today);
    res.json({ news, cached: false, date: today });
  } catch (err) {
    console.error("[FEHLER]", err.message);
    if (err.status) console.error("[FEHLER] HTTP Status:", err.status);
    if (cache.news.length > 0) {
      return res.json({ news: cache.news, cached: true, stale: true, date: cache.date });
    }
    res.status(503).json({ error: "Nachrichten nicht verfügbar. Bitte erneut versuchen." });
  }
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

app.listen(PORT, () => {
  console.log(`Mietrecht News Backend v5 auf Port ${PORT}`);
  console.log(`API-Key:  ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT"}`);
  console.log(`Redis:    ${(REDIS_URL && REDIS_TOKEN) ? "✓ konfiguriert" : "✗ FEHLT"}`);
  console.log(`VAPID:    ${VAPID_PUBLIC ? "✓" : "✗ FEHLT – Push deaktiviert"}`);
  console.log(`Cron:     täglich 09:00 Uhr Europe/Berlin`);
});

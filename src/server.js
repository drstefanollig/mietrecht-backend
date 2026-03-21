/**
 * Mietrecht News – Backend v4 mit Upstash Redis Cache
 * Cache überlebt Render-Neustarts – garantiert max. 1 API-Aufruf pro Tag
 */

const express   = require("express");
const cors      = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Upstash Redis Cache ───────────────────────────────────────────────────────
// Upstash REST API: Token wird als Authorization-Header übergeben
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL   || null;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || null;
const CACHE_KEY   = "mietrecht_cache";

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res  = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch(e) {
    console.warn("[REDIS] GET Fehler:", e.message);
    return null;
  }
}

async function redisSet(key, value) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/set/${key}/ex/90000`, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch(e) {
    console.warn("[REDIS] SET Fehler:", e.message);
  }
}

// ── Memory-Cache (schnell, innerhalb einer Session) ──────────────────────────
let cache = { date: null, news: [], titles: [] };

function cacheValid(today) {
  return cache.date === today && cache.news.length > 0;
}

// Beim Start: Cache aus Redis laden
(async function loadCache() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    console.warn("[CACHE] Kein UPSTASH_REDIS_REST_URL/TOKEN – Cache nicht persistent. Bitte Upstash einrichten.");
    return;
  }
  const saved = await redisGet(CACHE_KEY);
  if (!saved) { console.log("[CACHE] Kein Cache in Redis."); return; }
  const today = new Date().toLocaleDateString("sv-SE");
  if (saved.date === today && Array.isArray(saved.news) && saved.news.length > 0) {
    cache = saved;
    console.log(`[CACHE] ${cache.news.length} Nachrichten für ${cache.date} aus Redis geladen ✓`);
  } else {
    console.log(`[CACHE] Redis-Cache veraltet (${saved.date}) – neuer Abruf heute.`);
  }
})();

async function saveCache() {
  await redisSet(CACHE_KEY, cache);
  console.log(`[CACHE] In Redis gespeichert für ${cache.date}`);
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

GERICHTSURTEILE (mindestens 2 der 5 Nachrichten):
Suche aktiv nach aktuellen Urteilen von: BGH, OLG (alle Bundesländer), LG (alle großen Städte), AG (Amtsgerichte: AG München, AG Berlin-Mitte, AG Hamburg, AG Köln, AG Frankfurt, AG Stuttgart, AG Düsseldorf, AG Leipzig, AG Bremen, AG Hannover).
Themen: Kündigung, Kaution, Betriebskosten, Schönheitsreparaturen, Mietminderung, Eigenbedarfskündigung, Nebenkostenabrechnung, Schimmel, Lärmbelästigung, Tierhaltung, Untervermietung, Modernisierung.

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
  // Extrahiere JSON-Array – auch wenn Claude Text davor/danach schreibt
  const s = raw.indexOf("[");
  let e   = -1;
  // Suche das korrespondierende schließende ] durch Bracket-Counting
  if (s !== -1) {
    let depth = 0;
    for (let i = s; i < raw.length; i++) {
      if (raw[i] === "[" || raw[i] === "{") depth++;
      else if (raw[i] === "]" || raw[i] === "}") { depth--; if (depth === 0 && raw[i] === "]") { e = i; break; } }
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

// ── GET /api/news ─────────────────────────────────────────────────────────────
app.get("/api/news", async (req, res) => {
  const today = new Date().toLocaleDateString("sv-SE");

  // 1. Memory-Cache prüfen
  if (cacheValid(today)) {
    console.log(`[API] Memory-Cache Hit für ${today}`);
    return res.json({ news: cache.news, cached: true, date: today });
  }

  // 2. Redis-Cache prüfen (nach Neustart)
  const saved = await redisGet(CACHE_KEY);
  if (saved && saved.date === today && Array.isArray(saved.news) && saved.news.length > 0) {
    cache = saved;
    console.log(`[API] Redis-Cache Hit für ${today}`);
    return res.json({ news: cache.news, cached: true, date: today });
  }

  // 3. Neu von Claude holen
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

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  const today = new Date().toLocaleDateString("sv-SE");
  res.json({
    status:     "ok",
    cacheDate:  cache.date,
    cacheValid: cacheValid(today),
    cacheSize:  cache.news.length,
    redis:      (REDIS_URL && REDIS_TOKEN) ? "✓ konfiguriert" : "✗ FEHLT",
    apiKey:     process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT",
    uptime:     Math.floor(process.uptime()) + "s"
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mietrecht News Backend v4 (Redis) auf Port ${PORT}`);
  console.log(`API-Key: ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT"}`);
  console.log(`Redis:   ${REDIS_URL ? "✓ konfiguriert" : "✗ FEHLT – Cache nicht persistent!"}`);
});

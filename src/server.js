/**
 * Mietrecht News – Backend v3
 * Kostensparend: 6h-Cache, kürzere Texte, Haiku statt Sonnet
 */

const express   = require("express");
const cors      = require("cors");
const fs        = require("fs");
const path      = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Persistenter Tages-Cache ─────────────────────────────────────────────────
// Speichert Nachrichten in einer JSON-Datei – überlebt Server-Neustarts.
// Damit wird die Claude API garantiert maximal 1x pro Tag aufgerufen.
const CACHE_FILE = path.join("/tmp", "mietrecht_cache.json");

let cache = { date: null, news: [], titles: [] };

// Beim Start: Cache aus Datei laden
(function loadCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const saved = JSON.parse(raw);
    const today = new Date().toLocaleDateString("sv-SE");
    if (saved.date === today && Array.isArray(saved.news) && saved.news.length > 0) {
      cache = saved;
      console.log(`[CACHE] Tages-Cache geladen: ${cache.news.length} Nachrichten für ${cache.date}`);
    } else {
      console.log("[CACHE] Kein gültiger Cache für heute – neuer API-Aufruf beim ersten Request.");
    }
  } catch { console.log("[CACHE] Keine Cache-Datei gefunden – Neustart."); }
})();

function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch(e) { console.warn("[CACHE] Speichern fehlgeschlagen:", e.message); }
}

function cacheValid(today) {
  return cache.date === today && cache.news.length > 0;
}

// ── News holen ───────────────────────────────────────────────────────────────
async function fetchNews(today) {
  const known = cache.titles || [];

  const exclusionBlock = known.length > 0
    ? "\n\nBEREITS BERICHTET (nicht wiederholen):\n"
      + known.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "";

  // Kürzere Details → weniger Output-Tokens → niedrigere Kosten
  const systemPrompt =
    `Du bist Rechtsredakteur für deutsches Mietrecht. Recherchiere 5 aktuelle Nachrichten für ${today} aus UNTERSCHIEDLICHEN Themenbereichen.

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
[{"id":"${today}_1","titel":"max 12 Wörter","zusammenfassung":"2 prägnante Sätze mit konkreten Fakten","details":"max 80 Wörter, Aktenzeichen wenn vorhanden, konkrete Zahlen","kategorie":"urteil|gesetz|markt|beratung|politik","relevanz":"hoch|mittel","tags":["T1","T2"],"quelle":"Gericht/Institution + Aktenzeichen","url":"https://url-zur-originalmeldung-oder-leerer-string","datum":"${today}"}]`;

  console.log(`[${new Date().toISOString()}] API-Aufruf für ${today}...`);

  // Versuche mit Web Search, Fallback ohne
  let msg;
  try {
    msg = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",  // günstiger als Sonnet, ausreichend für News
      max_tokens: 3000,
      tools:      [{ type: "web_search_20250305", name: "web_search" }],
      system:     systemPrompt,
      messages:   [{ role: "user", content: `5 Mietrecht-Nachrichten ${today}. Nur JSON.` }]
    });
    console.log("[API] Mit Web Search OK");
  } catch (e) {
    console.warn("[API] Web Search Fallback:", e.message);
    msg = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 3000,
      system:     systemPrompt,
      messages:   [{ role: "user", content: `5 Mietrecht-Nachrichten ${today}. Nur JSON.` }]
    });
  }

  const textBlock = msg.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("Kein Text-Block");

  let raw = textBlock.text.replace(/```json|```/g, "").trim();
  const s = raw.indexOf("[");
  const e = raw.lastIndexOf("]");
  if (s === -1 || e === -1) throw new Error("Kein JSON-Array");
  raw = raw.slice(s, e + 1);

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Leeres Array");

  // Zitier-Tags und sonstige XML-Reste aus Textfeldern entfernen
  function stripTags(val) {
    if (typeof val !== "string") return val;
    return val.replace(/<[^>]+>/g, "").trim();
  }
  const news = parsed.map((n, i) => ({
    ...n,
    titel:          stripTags(n.titel),
    zusammenfassung: stripTags(n.zusammenfassung),
    details:        stripTags(n.details),
    quelle:         stripTags(n.quelle),
    url:            (typeof n.url === "string" && n.url.startsWith("http")) ? n.url : null,
    datum:          today,
    id:             `${today}_${i + 1}`,
    isMock:         false
  }));

  cache = {
    date:   today,
    news,
    titles: news.map(n => n.titel)
  };
  saveCache();

  console.log(`[${new Date().toISOString()}] OK – ${news.length} Nachrichten für ${today} gecacht und gespeichert.`);
  return news;
}

// ── GET /api/news ─────────────────────────────────────────────────────────────
app.get("/api/news", async (req, res) => {
  const today = new Date().toLocaleDateString("sv-SE");

  if (cacheValid(today)) {
    console.log(`[${new Date().toISOString()}] Cache-Hit für ${today}`);
    return res.json({ news: cache.news, cached: true, date: today });
  }

  try {
    const news = await fetchNews(today);
    res.json({ news, cached: false, date: today });
  } catch (err) {
    console.error("[FEHLER]", err.message);
    if (err.status) console.error("[FEHLER] HTTP Status:", err.status);
    if (err.error)  console.error("[FEHLER] API Error:", JSON.stringify(err.error));

    // Veralteten Cache lieber zurückgeben als 503
    if (cache.news.length > 0) {
      console.log("[FALLBACK] Veralteten Cache zurückgegeben");
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
    uptime:     Math.floor(process.uptime()) + "s",
    apiKey:     process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT"
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mietrecht News Backend v3 auf Port ${PORT}`);
  console.log(`API-Key: ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT"}`);
  console.log(`Cache-TTL: 6 Stunden`);
});

/**
 * Mietrecht News – Schlankes Backend (ohne Push, ohne Cron)
 * Render.com Free Tier kompatibel
 */

const express   = require("express");
const cors      = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Claude Client ───────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── News-Cache: verhindert unnötige API-Aufrufe ─────────────────────────────
// Speichert pro Tag genau einen Abruf – bei erneutem Aufruf am selben Tag
// werden die gecachten Nachrichten zurückgegeben.
let newsCache = {
  date:  null,   // "YYYY-MM-DD"
  news:  [],     // Array der 5 Nachrichten
  titles: []     // Titel für Duplikat-Schutz
};

// ── Bekannte Titel aus dem Cache holen (Duplikat-Schutz) ───────────────────
function getKnownTitles() {
  return newsCache.titles || [];
}

// ── Nachrichten von Claude holen ────────────────────────────────────────────
async function fetchNews(forceDate) {
  const today = forceDate || new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, timezone-safe
  const known = getKnownTitles();

  const exclusionBlock = known.length > 0
    ? "\n\nBEREITS BERICHTETE THEMEN (NICHT wiederholen, auch nicht sinngemäß):\n"
      + known.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "";

  const systemPrompt =
    `Du bist Rechtsredakteur für deutsches Mietrecht. Recherchiere 5 NEUE, bisher nicht berichtete Nachrichten für ${today}.
Erlaubte Quellen: BGH, OLG, LG-Urteile, Bundesjustizministerium, Bundesbauministerium, Deutscher Mieterbund, Verbraucherzentrale, Statistisches Bundesamt, IW Köln, KfW, GdW, Haufe Mietrecht, NJW, Immobilienscout24, vzbv, dpa.
Jede Nachricht muss eine ANDERE Quelle und ein ANDERES Thema haben.${exclusionBlock}

Antworte NUR mit einem JSON-Array, kein Markdown, kein Text davor oder danach:
[{"id":"${today}_1","titel":"…","zusammenfassung":"2-3 prägnante Sätze","details":"150-200 Wörter mit konkreten Zahlen und Fakten","kategorie":"urteil|gesetz|markt|beratung|politik","relevanz":"hoch|mittel","tags":["T1","T2"],"quelle":"Vollständige Quellenangabe","datum":"${today}"}]`;

  console.log(`[${new Date().toISOString()}] Fetching news for ${today}...`);

  // Versuche zuerst mit Web Search, Fallback ohne Web Search
  let msg;
  try {
    msg = await anthropic.messages.create({
      model:    "claude-sonnet-4-6",
      max_tokens: 4000,
      tools:    [{ type: "web_search_20250305", name: "web_search" }],
      system:   systemPrompt,
      messages: [{ role: "user", content: `5 neue Mietrecht-Nachrichten für ${today}. Jede aus anderer Quelle. Nur JSON-Array.` }]
    });
    console.log("[API] Web Search aktiviert – OK");
  } catch (webSearchErr) {
    console.warn("[API] Web Search fehlgeschlagen, Fallback ohne Web Search:", webSearchErr.message);
    msg = await anthropic.messages.create({
      model:    "claude-sonnet-4-6",
      max_tokens: 4000,
      system:   systemPrompt,
      messages: [{ role: "user", content: `5 neue Mietrecht-Nachrichten für ${today}. Jede aus anderer Quelle. Nur JSON-Array.` }]
    });
  }

  const textBlock = msg.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("Kein Text-Block in API-Antwort");

  // Robustes Parsing: extrahiere nur den JSON-Array-Teil
  let raw = textBlock.text.replace(/```json|```/g, "").trim();
  // Sicherheitshalber: nur den Teil von [ bis zum letzten } ] nehmen
  const arrStart = raw.indexOf("[");
  const arrEnd   = raw.lastIndexOf("]");
  if (arrStart === -1 || arrEnd === -1) throw new Error("Kein JSON-Array gefunden");
  raw = raw.slice(arrStart, arrEnd + 1);
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Leeres Array");

  // Datum und ID sauber setzen
  const news = parsed.map((n, i) => ({
    ...n,
    datum: today,
    id:    `${today}_${i + 1}`,
    isMock: false
  }));

  // Cache aktualisieren
  newsCache = {
    date:   today,
    news:   news,
    titles: news.map(n => n.titel)
  };

  console.log(`[${new Date().toISOString()}] OK – ${news.length} Nachrichten gecacht.`);
  return news;
}

// ── GET /api/news ───────────────────────────────────────────────────────────
// ?refresh=1  → Cache ignorieren, neu laden
app.get("/api/news", async (req, res) => {
  const today   = new Date().toLocaleDateString("sv-SE");
  const refresh = req.query.refresh === "1";

  // Cache treffer: gleicher Tag, kein Force-Refresh
  if (!refresh && newsCache.date === today && newsCache.news.length > 0) {
    console.log(`[${new Date().toISOString()}] Cache-Hit für ${today}`);
    return res.json({ news: newsCache.news, cached: true, date: today });
  }

  try {
    const news = await fetchNews(today);
    res.json({ news, cached: false, date: today });
  } catch (err) {
    console.error("[FEHLER] fetchNews:", err.message);
    if (err.status) console.error("[FEHLER] HTTP Status:", err.status);
    if (err.error)  console.error("[FEHLER] API Error:", JSON.stringify(err.error));
    // Wenn Cache noch brauchbar (anderer Tag aber besser als nichts): zurückgeben
    if (newsCache.news.length > 0) {
      return res.json({ news: newsCache.news, cached: true, date: newsCache.date, stale: true });
    }
    res.status(503).json({ error: "Nachrichten vorübergehend nicht verfügbar. Bitte erneut versuchen." });
  }
});

// ── GET /health ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status:    "ok",
    cacheDate: newsCache.date,
    cacheSize: newsCache.news.length,
    uptime:    Math.floor(process.uptime()) + "s",
    apiKey:    process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT"
  });
});

// ── Server starten ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mietrecht News Backend läuft auf Port ${PORT}`);
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "✓ gesetzt" : "✗ FEHLT – /api/news wird nicht funktionieren"}`);
});

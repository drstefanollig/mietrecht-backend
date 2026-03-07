/**
 * Mietrecht News – Backend v3
 * Kostensparend: 6h-Cache, kürzere Texte, Haiku statt Sonnet
 */

const express   = require("express");
const cors      = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Cache ────────────────────────────────────────────────────────────────────
// Speichert Nachrichten + Zeitstempel des letzten Abrufs.
// Neue API-Anfrage nur wenn: anderer Tag ODER letzter Abruf > 6 Stunden her.
let cache = {
  date:      null,   // "YYYY-MM-DD"
  fetchedAt: null,   // Timestamp (ms) des letzten erfolgreichen Abrufs
  news:      [],
  titles:    []
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 Stunden

function cacheValid(today) {
  if (!cache.date || !cache.fetchedAt || cache.news.length === 0) return false;
  if (cache.date !== today) return false;
  const age = Date.now() - cache.fetchedAt;
  return age < CACHE_TTL_MS;
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
    `Du bist Rechtsredakteur für deutsches Mietrecht. Liefere 5 neue Nachrichten für ${today}.
Quellen: BGH, OLG, LG, Bundesjustizministerium, Bundesbauministerium, Mieterbund, Verbraucherzentrale, Statistisches Bundesamt, IW Köln, KfW, Haufe, NJW, dpa.
Jede Nachricht: andere Quelle, anderes Thema.${exclusionBlock}

Antworte NUR mit JSON-Array, kein Markdown, keine XML-Tags, keine <cite>-Tags, kein Fließtext außerhalb des Arrays:
[{"id":"${today}_1","titel":"max 12 Wörter","zusammenfassung":"2 Sätze","details":"max 80 Wörter, konkrete Fakten","kategorie":"urteil|gesetz|markt|beratung|politik","relevanz":"hoch|mittel","tags":["T1","T2"],"quelle":"Quellenangabe","datum":"${today}"}]`;

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
    datum:          today,
    id:             `${today}_${i + 1}`,
    isMock:         false
  }));

  cache = {
    date:      today,
    fetchedAt: Date.now(),
    news,
    titles: news.map(n => n.titel)
  };

  console.log(`[${new Date().toISOString()}] OK – ${news.length} Nachrichten, Cache bis ${new Date(cache.fetchedAt + CACHE_TTL_MS).toISOString()}`);
  return news;
}

// ── GET /api/news ─────────────────────────────────────────────────────────────
app.get("/api/news", async (req, res) => {
  const today = new Date().toLocaleDateString("sv-SE");

  if (cacheValid(today)) {
    const ageMin = Math.floor((Date.now() - cache.fetchedAt) / 60000);
    console.log(`[${new Date().toISOString()}] Cache-Hit (${ageMin} min alt)`);
    return res.json({ news: cache.news, cached: true, date: today, cacheAgeMin: ageMin });
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
  const ageMin = cache.fetchedAt ? Math.floor((Date.now() - cache.fetchedAt) / 60000) : null;
  res.json({
    status:       "ok",
    cacheDate:    cache.date,
    cacheValid:   cacheValid(today),
    cacheAgeMin:  ageMin,
    cacheSize:    cache.news.length,
    uptime:       Math.floor(process.uptime()) + "s",
    apiKey:       process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT"
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mietrecht News Backend v3 auf Port ${PORT}`);
  console.log(`API-Key: ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ FEHLT"}`);
  console.log(`Cache-TTL: 6 Stunden`);
});

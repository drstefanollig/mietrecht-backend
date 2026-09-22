/**
 * Nachrichtenquellen: RSS-Feeds mit Originallinks + Artikeltext
 * Claude fasst nur zusammen, was hier gefunden wird – Links kommen nie vom Modell.
 */

const USER_AGENT = "Mozilla/5.0 (compatible; CaperaMietrechtNews/1.0; +https://mietrecht.netlify.app)";

const bing = q => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=de&cc=DE`;

const FEEDS = [
  { name: "Haufe Immobilien",       url: "https://www.haufe.de/xml/rss_129130.xml" },
  { name: "BGH-Pressemitteilung",   url: "https://www.bundesgerichtshof.de/DE/Service/RSSFeed/Function/RSS_PM.xml", maxAgeDays: 21 },
  { name: "LTO",                    url: "https://www.lto.de/rss/feed.xml" },
  { name: "beck-aktuell",           url: "https://www.beck-aktuell.de/rss.xml" },
  { name: "Haus & Grund",           url: "https://www.hausundgrund.de/rss/rss.xml" },
  { name: "Bing News",              url: bing("Mietrecht Urteil"), viaBing: true },
  { name: "Bing News",              url: bing("Wohnungseigentum WEG Urteil"), viaBing: true },
];

// Grobfilter – die inhaltliche Auswahl trifft Claude. "WEG" case-sensitiv, sonst trifft es das Wort "weg".
const RELEVANT = /mietrecht|\bmiet|mieter|vermiet|wohnung|wohnraum|wohnungseigentum|eigentümergemeinschaft|eigentümerversammlung|hausgeld|nebenkost|betriebskost|heizkost|kaution|eigenbedarf|räumung|modernisierung|schönheitsrepar|schimmel|mietpreis|mietspiegel|hausverwalt|immobilienverwalt|makler|grundsteuer|gebäudeenergie|heizungsgesetz/i;
const RELEVANT_WEG = /\bWEG\b/;
const isRelevant = text => RELEVANT.test(text) || RELEVANT_WEG.test(text);

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function htmlToText(s) {
  return decodeEntities(String(s || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

function cleanUrl(raw, viaBing) {
  try {
    let u = new URL(decodeEntities(raw).trim());
    if (viaBing) {
      const target = u.searchParams.get("url");
      if (!target) return null;
      u = new URL(target);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    for (const key of [...u.searchParams.keys()]) {
      if (key.startsWith("utm_") || (key === "r" && u.searchParams.get(key) === "rss")) u.searchParams.delete(key);
    }
    return u.toString();
  } catch (e) {
    return null;
  }
}

function parseDate(block) {
  const raw = htmlToText(tag(block, "pubDate") || tag(block, "dc:date"));
  const d = raw ? new Date(raw) : null;
  return d && !isNaN(d) ? d : null;
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "de-DE,de;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchFeed(feed) {
  const xml = await fetchText(feed.url, 10000);
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return items.map(block => {
    const source = feed.viaBing ? htmlToText(tag(block, "News:Source")) || "Bing News" : feed.name;
    return {
      title:       htmlToText(tag(block, "title")),
      link:        cleanUrl(tag(block, "link"), feed.viaBing),
      description: htmlToText(tag(block, "description")).slice(0, 600),
      published:   parseDate(block),
      source,
      maxAgeDays:  feed.maxAgeDays
    };
  }).filter(i => i.title && i.link && i.published);
}

function normTitle(t) {
  return t.toLowerCase().replace(/[^a-zäöüß0-9]+/g, " ").trim().slice(0, 80);
}

/**
 * Kandidaten für einen Stichtag: aktuell, relevant, noch nicht gemeldet, ohne Dubletten.
 * Round-Robin über die Quellen, damit nicht eine Quelle alles dominiert.
 */
async function fetchCandidates(date, { excludeUrls = new Set(), maxAgeDays = 10, limit = 20 } = {}) {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.warn(`[QUELLEN] ${FEEDS[i].name} fehlgeschlagen:`, r.reason.message);
  });
  const all = results.flatMap(r => (r.status === "fulfilled" ? r.value : []));

  const end = new Date(`${date}T23:59:59Z`);
  const seenUrls = new Set(), seenTitles = new Set();
  const fresh = all
    .filter(i => {
      const age = (end - i.published) / 86400000;
      return age >= -1 && age <= (i.maxAgeDays || maxAgeDays);
    })
    .filter(i => isRelevant(`${i.title} ${i.description}`))
    .filter(i => !excludeUrls.has(i.link))
    .sort((a, b) => b.published - a.published)
    .filter(i => {
      const t = normTitle(i.title);
      if (seenUrls.has(i.link) || seenTitles.has(t)) return false;
      seenUrls.add(i.link); seenTitles.add(t);
      return true;
    });

  const bySource = new Map();
  for (const i of fresh) {
    if (!bySource.has(i.source)) bySource.set(i.source, []);
    bySource.get(i.source).push(i);
  }
  const picked = [];
  while (picked.length < limit && [...bySource.values()].some(list => list.length)) {
    for (const list of bySource.values()) {
      if (list.length && picked.length < limit) picked.push(list.shift());
    }
  }
  console.log(`[QUELLEN] ${all.length} Meldungen geladen, ${fresh.length} relevant/neu, ${picked.length} Kandidaten`);
  return picked;
}

function longParagraphs(html) {
  return (html.match(/<p[\s>][\s\S]*?<\/p>/gi) || []).map(htmlToText).filter(p => p.length >= 60);
}

/** Fließtext eines Artikels (für belastbare Zusammenfassungen) – leer bei Fehler/Paywall. */
async function fetchArticleText(url, maxChars = 2500) {
  try {
    const html = (await fetchText(url, 8000))
      .replace(/<(script|style|nav|header|footer|aside)[\s>][\s\S]*?<\/\1>/gi, " ");
    const meta = html.match(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]*)"/i);
    const lead = meta ? htmlToText(meta[1]) : "";

    // <article> ist oft nur eine Teaser-Kachel: den Block mit dem meisten Fließtext nehmen,
    // sonst die Absätze der ganzen Seite in Dokumentreihenfolge.
    let body = [];
    for (const block of html.match(/<(article|main)[\s>][\s\S]*?<\/\1>/gi) || []) {
      const ps = longParagraphs(block);
      if (ps.join("").length > body.join("").length) body = ps;
    }
    if (body.join("").length < 400) body = longParagraphs(html);

    const parts = [lead, ...body].filter((p, i, arr) => p && arr.indexOf(p) === i);
    return parts.join("\n").slice(0, maxChars);
  } catch (e) {
    return "";
  }
}

module.exports = { fetchCandidates, fetchArticleText };

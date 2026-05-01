const headers = {
  "content-type": "application/json;charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ja,en-US;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      "pragma": "no-cache"
    }
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${url}`);
  return await res.text();
}

function parseHorsesJp(html) {
  const horses = [];
  const rows = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const text = stripHtml(row);

    const noMatch =
      row.match(/class=["'][^"']*(?:Umaban|Horse_Num)[^"']*["'][^>]*>\s*([1-9]|1[0-8])\s*</i) ||
      row.match(/<td[^>]*class=["'][^"']*Umaban[^"']*["'][^>]*>\s*([1-9]|1[0-8])\s*</i);

    const frameMatch =
      row.match(/class=["'][^"']*(?:Waku|Frame)[^"']*["'][^>]*>\s*([1-8])\s*</i);

    const nameMatch =
      row.match(/class=["'][^"']*HorseName[^"']*["'][\s\S]*?<a[^>]*>([^<]+)<\/a>/i) ||
      row.match(/\/horse\/\d+[^>]*>([^<]+)<\/a>/i);

    const oddsMatch =
      row.match(/class=["'][^"']*(?:Odds|Popular)[^"']*["'][^>]*>\s*([0-9]+(?:\.[0-9]+)?)\s*</i) ||
      text.match(/\b([0-9]+\.[0-9])\b/);

    if (!noMatch || !nameMatch) continue;

    const no = String(noMatch[1]);
    const name = stripHtml(nameMatch[1]);
    if (!name || horses.some(h => h.no === no)) continue;

    horses.push({
      frame: frameMatch ? String(frameMatch[1]) : String(Math.ceil(Number(no) / 2)),
      no,
      name,
      last1: "",
      last2: "",
      last3: "",
      odds: oddsMatch ? String(oddsMatch[1]) : "",
      popularity: ""
    });
  }

  return horses.sort((a, b) => Number(a.no) - Number(b.no));
}

function parseHorsesEn(html) {
  const horses = [];
  const rows = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const noMatch =
      row.match(/class=["'][^"']*Horse_Num[^"']*["'][^>]*>\s*([1-9]|1[0-8])\s*</i) ||
      row.match(/<td[^>]*>\s*([1-9]|1[0-8])\s*<\/td>/i);

    const nameMatch =
      row.match(/class=["'][^"']*Horse_Name[^"']*["'][\s\S]*?<a[^>]*>([^<]+)<\/a>/i) ||
      row.match(/\/horse\/\d+[^>]*>([^<]+)<\/a>/i);

    if (!noMatch || !nameMatch) continue;

    const no = String(noMatch[1]);
    const name = stripHtml(nameMatch[1]);
    if (!name || horses.some(h => h.no === no)) continue;

    horses.push({
      frame: String(Math.ceil(Number(no) / 2)),
      no,
      name,
      last1: "",
      last2: "",
      last3: "",
      odds: "",
      popularity: ""
    });
  }

  return horses.sort((a, b) => Number(a.no) - Number(b.no));
}

function addPopularityByOdds(horses) {
  const valid = horses
    .map(h => ({ h, odds: Number(h.odds) }))
    .filter(x => Number.isFinite(x.odds) && x.odds > 0)
    .sort((a, b) => a.odds - b.odds);

  let rank = 1;
  let prev = null;
  valid.forEach((x, i) => {
    if (prev !== null && x.odds !== prev) rank = i + 1;
    x.h.popularity = String(rank);
    prev = x.odds;
  });

  horses.forEach(h => { if (!h.popularity) h.popularity = ""; });
  return horses;
}

async function fetchEntry(raceId) {
  const urls = [
    { type: "jp", url: `https://race.netkeiba.com/race/shutuba.html?race_id=${raceId}` },
    { type: "en", url: `https://en.netkeiba.com/race/racecard.html?race_id=${raceId}` },
    { type: "en", url: `https://en.netkeiba.com/race/newspaper.html?race_id=${raceId}` }
  ];

  const errors = [];

  for (const target of urls) {
    try {
      const html = await fetchText(target.url);
      const horses = addPopularityByOdds(target.type === "jp" ? parseHorsesJp(html) : parseHorsesEn(html));
      if (horses.length > 0) {
        return { ok: true, raceId, count: horses.length, horses, source: target.type === "jp" ? "netkeiba-jp-entry" : "netkeiba-en-entry", sourceUrl: target.url };
      }
      errors.push(`${target.url}: parsed 0`);
    } catch (e) {
      errors.push(`${target.url}: ${String(e.message || e)}`);
    }
  }

  return { ok: false, raceId, count: 0, horses: [], error: "entry not found or blocked", errors };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(JSON.stringify({ ok: true }), { headers });

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true, service: "rev-worker-entry", endpoints: ["/api/entry?raceId=..."] }), { headers });
    }

    if (url.pathname !== "/api/entry") {
      return new Response(JSON.stringify({ ok: false, error: "not found", path: url.pathname }), { status: 404, headers });
    }

    let raceId = url.searchParams.get("raceId") || "";

    if (request.method === "POST") {
      try {
        const body = await request.json();
        raceId = body.raceId || body.sourceRaceId || raceId;
      } catch (_) {}
    }

    raceId = String(raceId || "").replace(/\D/g, "");

    if (!/^\d{12}$/.test(raceId)) {
      return new Response(JSON.stringify({ ok: false, error: "raceId must be 12 digits", raceId }), { status: 400, headers });
    }

    const result = await fetchEntry(raceId);
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : 502, headers });
  }
};

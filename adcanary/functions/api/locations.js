// GET  /api/locations?customerId=<id>&dateRange=<gaql>&level=<country|region|county|city|postcode>[&debug=1]
// Location performance for the Locations page, from user_location_view — the data behind the
// Google Ads "Where your users were" report, i.e. users' PHYSICAL locations only (no
// "locations of interest"). `level` picks the breakdown (default city):
//   country  → user_location_view.country_criterion_id
//   region   → segments.geo_target_region   (falls back to province / state if Google files the
//              account's regions under those instead)
//   county   → segments.geo_target_county
//   city     → segments.geo_target_city
//   postcode → segments.geo_target_postal_code
// (Response keys still say "cities" for compatibility; they hold whichever level was asked for.)
//
// GET /api/locations?customerId=<id>&mode=shapes&ids=<geoId,geoId,...>
// Boundary outlines (GeoJSON) for the Country / Region map view, from OpenStreetMap Nominatim.
// Cached in KV for 90 days per location; at most 6 live lookups per call (~1/sec), the rest
// come back in `pending` for the browser to ask for again.
//   { shapes: { <geoId>: geometry | null }, pending: [geoId] }
//   { rows:   [{ geoId, campaignId, campaign, status, impressions, clicks, cost, conversions }],
//     cities: { <geoId>: { name, canonical, countryCode, lat?, lng? } },
//     unattributed: { impressions, clicks, cost, conversions },   // traffic Google couldn't pin to a city
//     warning? }
//
// The Ads API has no coordinates for cities, so map positions come from OpenStreetMap
// (geocoded in the browser, a city at a time) and are shared through one KV entry:
// POST /api/locations  { coords: { <geoId>: [lat, lng] | null } }  merges new positions in.
// null = "looked up, not found", so nobody retries it.

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

const KV_KEY = "geo:cities:v1";

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  const debug = url.searchParams.get("debug") === "1";
  if (!customerId || customerId === "ALL") return json({ error: "Select a single account" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  const drParam = url.searchParams.get("dateRange") || "LAST_30_DAYS";
  const drFixed = drParam.replace(/'(\d{4})(\d{2})(\d{2})'/g, "'$1-$2-$3'");
  const drSafe = /^[A-Z0-9_]+$/.test(drFixed) || /^segments\.date >= '\d{4}-\d{2}-\d{2}' AND segments\.date <= '\d{4}-\d{2}-\d{2}'$/.test(drFixed);
  const dateClause = drSafe ? (/segments\.date/i.test(drFixed) ? drFixed : "segments.date DURING " + drFixed) : "segments.date DURING LAST_30_DAYS";

  const accessToken = await getAccessToken(env, refreshToken);
  const search = async (query) => {
    const out = [];
    let pageToken, pages = 0;
    do {
      const r = await adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, pageToken ? { query, pageToken } : { query });
      out.push(...(r.results || []));
      pageToken = r.nextPageToken;
    } while (pageToken && ++pages < 20);
    return out;
  };
  const idOf = (rn) => String(rn || "").split("/").pop();
  const warnings = [];

  if (url.searchParams.get("mode") === "shapes") {
    const ids = [...new Set(String(url.searchParams.get("ids") || "").split(",").filter((x) => /^\d{1,12}$/.test(x)))].slice(0, 20);
    return json(await loadShapes(ids, search, env));
  }

  // Level → GAQL field(s) to try in order, and how to read the location off a result row.
  const LEVELS = {
    country: [{ field: "user_location_view.country_criterion_id", read: (r) => (r.userLocationView?.countryCriterionId ? "geoTargetConstants/" + r.userLocationView.countryCriterionId : "") }],
    region: [
      { field: "segments.geo_target_region", read: (r) => r.segments?.geoTargetRegion },
      { field: "segments.geo_target_province", read: (r) => r.segments?.geoTargetProvince },
      { field: "segments.geo_target_state", read: (r) => r.segments?.geoTargetState },
    ],
    county: [{ field: "segments.geo_target_county", read: (r) => r.segments?.geoTargetCounty }],
    city: [{ field: "segments.geo_target_city", read: (r) => r.segments?.geoTargetCity }],
    postcode: [{ field: "segments.geo_target_postal_code", read: (r) => r.segments?.geoTargetPostalCode }],
  };
  const level = LEVELS[url.searchParams.get("level")] ? url.searchParams.get("level") : "city";
  const geoQ = (field) => `SELECT campaign.id, campaign.name, campaign.status, ${field},
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM user_location_view
    WHERE campaign.status != 'REMOVED' AND ${dateClause}`;

  // Try each candidate field for the level; keep the first that attributes any traffic.
  const fetchLevel = async () => {
    let last = null, firstErr = null;
    for (const cand of LEVELS[level]) {
      try {
        const rows = await search(geoQ(cand.field));
        last = { rows, cand };
        if (rows.some((r) => cand.read(r))) return last;
      } catch (e) { if (!firstErr) firstErr = e; }
    }
    if (last) return last;
    throw firstErr || new Error("No data");
  };

  let geoRows, used;
  const [geoR, endedR, kvR] = await Promise.allSettled([
    fetchLevel(),
    search(`SELECT campaign.id, campaign.serving_status FROM campaign WHERE campaign.status = 'ENABLED'`),
    env.SESSIONS ? env.SESSIONS.get(KV_KEY, "json") : Promise.resolve(null),
  ]);
  if (geoR.status !== "fulfilled") {
    const msg = String(geoR.reason?.message || geoR.reason).slice(0, 300);
    return json(debug ? { error: "Could not load location data", detail: msg, query: geoQ(LEVELS[level][0].field) } : { error: "Could not load location data: " + msg.slice(0, 160) }, 500);
  }
  geoRows = geoR.value.rows; used = geoR.value.cand;
  const ended = new Set();
  if (endedR.status === "fulfilled") endedR.value.forEach((r) => { if (r.campaign?.servingStatus === "ENDED") ended.add(String(r.campaign.id)); });
  const coordStore = (kvR.status === "fulfilled" && kvR.value) || {};

  // Region level: Google's region segment isn't one consistent tier (in the UK it returns a mix
  // of nations, counties and council areas). Roll every location up through its parents to the
  // first level below the country — England / Scotland / Wales / Northern Ireland for the UK.
  let mapRn = (rn) => rn;
  if (level === "region") {
    const info = new Map(); // rn -> { parent, type }
    let todo = [...new Set(geoRows.map((r) => used.read(r)).filter(Boolean))];
    for (let round = 0; round < 5 && todo.length; round++) {
      const next = new Set();
      for (let i = 0; i < todo.length; i += 400) {
        const chunk = todo.slice(i, i + 400);
        try {
          (await search(`SELECT geo_target_constant.resource_name, geo_target_constant.parent_geo_target, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${chunk.map((rn) => `'${rn}'`).join(", ")})`))
            .forEach((g) => {
              const c = g.geoTargetConstant || {};
              info.set(c.resourceName, { parent: c.parentGeoTarget || "", type: c.targetType || "" });
              if (c.parentGeoTarget && !info.has(c.parentGeoTarget)) next.add(c.parentGeoTarget);
            });
        } catch (e) { warnings.push("Couldn't group some locations into regions."); round = 99; break; }
      }
      todo = [...next].filter((rn) => !info.has(rn));
    }
    const top = new Map();
    mapRn = (rn) => {
      if (top.has(rn)) return top.get(rn);
      let cur = rn;
      for (let i = 0; i < 6; i++) {
        const me = info.get(cur);
        if (!me || me.type === "Country" || !me.parent) break;
        const parent = info.get(me.parent);
        if (!parent || parent.type === "Country") break; // cur sits directly under the country
        cur = me.parent;
      }
      top.set(rn, cur);
      return cur;
    };
  }

  // Aggregate to one row per location per campaign (user_location_view also splits by country /
  // targeted-or-not, so rows are summed).
  const byKey = new Map();
  const unattributed = { impressions: 0, clicks: 0, cost: 0, conversions: 0 };
  const cityRns = new Set();
  for (const r of geoRows) {
    const m = r.metrics || {};
    const v = { impressions: Number(m.impressions) || 0, clicks: Number(m.clicks) || 0, cost: (Number(m.costMicros) || 0) / 1e6, conversions: Number(m.conversions) || 0 };
    const rn = used.read(r) ? mapRn(used.read(r)) : "";
    if (!rn) { for (const k in v) unattributed[k] += v[k]; continue; }
    cityRns.add(rn);
    const geoId = idOf(rn), cid = String(r.campaign?.id || "");
    const key = geoId + "|" + cid;
    let row = byKey.get(key);
    if (!row) {
      const st = r.campaign?.status || "";
      row = { geoId, campaignId: cid, campaign: r.campaign?.name || "", status: st === "ENABLED" && ended.has(cid) ? "ENDED" : st, impressions: 0, clicks: 0, cost: 0, conversions: 0 };
      byKey.set(key, row);
    }
    for (const k in v) row[k] += v[k];
  }

  // City names (chunked IN lists).
  const cities = {};
  const rnList = [...cityRns];
  for (let i = 0; i < rnList.length; i += 400) {
    const chunk = rnList.slice(i, i + 400);
    try {
      const res = await search(`SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.country_code, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${chunk.map((rn) => `'${rn}'`).join(", ")})`);
      res.forEach((g) => {
        const c = g.geoTargetConstant || {};
        cities[String(c.id)] = { name: c.name || "", canonical: c.canonicalName || c.name || "", countryCode: c.countryCode || "", type: c.targetType || "" };
      });
    } catch (e) { warnings.push("Some location names couldn't be loaded."); break; }
  }
  rnList.forEach((rn) => {
    const id = idOf(rn);
    if (!cities[id]) cities[id] = { name: "Location " + id, canonical: "", countryCode: "" };
    const c = coordStore[id];
    if (Array.isArray(c)) { cities[id].lat = c[0]; cities[id].lng = c[1]; }
    else if (c === null) cities[id].noGeo = true;
  });

  const payload = { rows: [...byKey.values()], cities, unattributed, level, field: used.field };
  if (warnings.length) payload.warning = warnings.join(" ");
  if (debug) payload.diag = { geoRows: geoRows.length, cities: rnList.length, cachedCoords: Object.keys(coordStore).length };
  return json(payload);
}

// Merge geocoded city positions into the shared KV store.
export async function onRequestPost(context) {
  const { request, env } = context;
  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);
  if (!env.SESSIONS) return json({ ok: false });
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const incoming = body && body.coords && typeof body.coords === "object" ? body.coords : {};
  const clean = {};
  let n = 0;
  for (const [id, v] of Object.entries(incoming)) {
    if (!/^\d{1,12}$/.test(id) || ++n > 200) continue;
    if (v === null) clean[id] = null;
    else if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && isFinite(x)) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180) {
      clean[id] = [Math.round(v[0] * 1e5) / 1e5, Math.round(v[1] * 1e5) / 1e5];
    }
  }
  if (!Object.keys(clean).length) return json({ ok: true, saved: 0 });
  let store = {};
  try { store = (await env.SESSIONS.get(KV_KEY, "json")) || {}; } catch {}
  Object.assign(store, clean);
  try { await env.SESSIONS.put(KV_KEY, JSON.stringify(store)); } catch (e) { return json({ ok: false, error: "Could not save" }, 500); }
  return json({ ok: true, saved: Object.keys(clean).length });
}

// ----- Boundary outlines for the Country / Region view -----
const SHAPE_KV = (id) => "geoshape:v1:" + id;
const SHAPE_TTL = 60 * 60 * 24 * 90;
async function loadShapes(ids, search, env) {
  const kv = env && env.SESSIONS;
  const shapes = {}, need = [], pending = [];
  for (const id of ids) {
    let hit = null;
    if (kv) { try { hit = await kv.get(SHAPE_KV(id), "json"); } catch {} }
    if (hit) shapes[id] = hit.geometry || null; else need.push(id);
  }
  if (!need.length) return { shapes, pending };

  const names = {};
  try {
    (await search(`SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.country_code, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${need.map((id) => `'geoTargetConstants/${id}'`).join(", ")})`))
      .forEach((g) => { const c = g.geoTargetConstant || {}; names[String(c.id)] = { name: c.name || "", canonical: c.canonicalName || c.name || "", cc: c.countryCode || "", type: c.targetType || "" }; });
  } catch { return { shapes, pending: need }; }

  const deadline = Date.now() + 15000;
  let live = 0;
  for (const id of need) {
    const n = names[id];
    if (!n) { shapes[id] = null; continue; }
    if (live >= 6 || Date.now() > deadline) { pending.push(id); continue; }
    if (live) await new Promise((r) => setTimeout(r, 1000)); // Nominatim: max ~1 request/second
    live++;
    const qs = n.type === "Country"
      ? "country=" + encodeURIComponent(n.name)
      : "q=" + encodeURIComponent(n.canonical.replace(/,/g, ", ")) + (n.cc ? "&countrycodes=" + n.cc.toLowerCase() : "");
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&polygon_geojson=1&polygon_threshold=0.01&" + qs,
        { signal: ctrl.signal, headers: { "User-Agent": "AdCanary/1.0 (https://adcanary.app)", "Accept-Language": "en-GB" } });
      if (!res.ok) { pending.push(id); continue; }
      const arr = await res.json();
      const gj = arr && arr[0] && arr[0].geojson;
      const geometry = gj && /Polygon$/.test(gj.type) ? gj : null;
      shapes[id] = geometry;
      if (kv) { try { await kv.put(SHAPE_KV(id), JSON.stringify({ geometry }), { expirationTtl: SHAPE_TTL }); } catch {} }
    } catch { pending.push(id); }
    finally { clearTimeout(timer); }
  }
  return { shapes, pending };
}

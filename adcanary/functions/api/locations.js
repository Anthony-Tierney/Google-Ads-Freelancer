// GET  /api/locations?customerId=<id>&dateRange=<gaql>[&debug=1]
// City-level performance for the Locations page, from user_location_view segmented by
// segments.geo_target_city — the data behind the Google Ads "Where your users were" report,
// i.e. users' PHYSICAL locations only (no "locations of interest").
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

  const GEO_Q = `SELECT campaign.id, campaign.name, campaign.status, segments.geo_target_city,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM user_location_view
    WHERE campaign.status != 'REMOVED' AND ${dateClause}`;

  let geoRows;
  const [geoR, endedR, kvR] = await Promise.allSettled([
    search(GEO_Q),
    search(`SELECT campaign.id, campaign.serving_status FROM campaign WHERE campaign.status = 'ENABLED'`),
    env.SESSIONS ? env.SESSIONS.get(KV_KEY, "json") : Promise.resolve(null),
  ]);
  if (geoR.status !== "fulfilled") {
    const msg = String(geoR.reason?.message || geoR.reason).slice(0, 300);
    return json(debug ? { error: "Could not load city data", detail: msg, query: GEO_Q } : { error: "Could not load city data: " + msg.slice(0, 160) }, 500);
  }
  geoRows = geoR.value;
  const ended = new Set();
  if (endedR.status === "fulfilled") endedR.value.forEach((r) => { if (r.campaign?.servingStatus === "ENDED") ended.add(String(r.campaign.id)); });
  const coordStore = (kvR.status === "fulfilled" && kvR.value) || {};

  // Aggregate to one row per city per campaign (user_location_view also splits by country /
  // targeted-or-not, so rows are summed).
  const byKey = new Map();
  const unattributed = { impressions: 0, clicks: 0, cost: 0, conversions: 0 };
  const cityRns = new Set();
  for (const r of geoRows) {
    const m = r.metrics || {};
    const v = { impressions: Number(m.impressions) || 0, clicks: Number(m.clicks) || 0, cost: (Number(m.costMicros) || 0) / 1e6, conversions: Number(m.conversions) || 0 };
    const rn = r.segments?.geoTargetCity;
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
      const res = await search(`SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${chunk.map((rn) => `'${rn}'`).join(", ")})`);
      res.forEach((g) => {
        const c = g.geoTargetConstant || {};
        cities[String(c.id)] = { name: c.name || "", canonical: c.canonicalName || c.name || "", countryCode: c.countryCode || "" };
      });
    } catch (e) { warnings.push("Some city names couldn't be loaded."); break; }
  }
  rnList.forEach((rn) => {
    const id = idOf(rn);
    if (!cities[id]) cities[id] = { name: "City " + id, canonical: "", countryCode: "" };
    const c = coordStore[id];
    if (Array.isArray(c)) { cities[id].lat = c[0]; cities[id].lng = c[1]; }
    else if (c === null) cities[id].noGeo = true;
  });

  const payload = { rows: [...byKey.values()], cities, unattributed };
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

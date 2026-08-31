// GET /api/reporting?customerId=ALL|<id>&dateRange=<gaql date clause>&campaign=<name>
// Returns scorecard totals AND a per-day time series for the Reporting chart:
//   { clicks, impressions, cost, conversions, searchImpShare, searchClickShare, accounts,
//     series: [{ date, clicks, impressions, cost, conversions, impShareW, clickShareW, shareWeight }], _errors? }
// The client buckets `series` by Day/Week/Month/Quarter and derives ratio metrics.
//   • No campaign  → account-level (FROM customer), core + share queried separately.
//   • With campaign → campaign-level (FROM campaign), impression share valid in one query.

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

const escGaql = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId") || "ALL";
  const drParam = url.searchParams.get("dateRange") || "LAST_30_DAYS";
  const dateClause = /segments\.date/i.test(drParam) ? drParam : "segments.date DURING " + drParam;
  const campaign = url.searchParams.get("campaign") || "";

  const accessToken = await getAccessToken(env, refreshToken);

  let ids;
  if (customerId === "ALL") {
    const list = await adsRequest(env, accessToken, "customers:listAccessibleCustomers");
    ids = (list.resourceNames || []).map((rn) => rn.split("/")[1]);
  } else {
    ids = [customerId.replace(/-/g, "")];
  }

  let clicks = 0, impressions = 0, cost = 0, conversions = 0;
  let impShareW = 0, clickShareW = 0, shareWeight = 0, accounts = 0;
  const errors = [];
  const byDate = {};
  const bucket = (d) => byDate[d] || (byDate[d] = { clicks: 0, impressions: 0, cost: 0, conversions: 0, impShareW: 0, clickShareW: 0, shareWeight: 0 });

  const addCore = (d, m) => {
    const cl = Number(m.clicks) || 0, im = Number(m.impressions) || 0, co = (Number(m.costMicros) || 0) / 1e6, cv = Number(m.conversions) || 0;
    clicks += cl; impressions += im; cost += co; conversions += cv;
    if (d) { const b = bucket(d); b.clicks += cl; b.impressions += im; b.cost += co; b.conversions += cv; }
  };
  const addShare = (d, m) => {
    const im = Number(m.impressions) || 0;
    if (m.searchImpressionShare != null && im > 0) { const w = Number(m.searchImpressionShare) * im; impShareW += w; shareWeight += im; if (d) { const b = bucket(d); b.impShareW += w; b.shareWeight += im; } }
    if (m.searchClickShare != null && im > 0) { const w = Number(m.searchClickShare) * im; clickShareW += w; if (d) bucket(d).clickShareW += w; }
  };

  if (campaign) {
    // Campaign-level — FROM campaign supports impression share, so one query per account.
    const q = `SELECT segments.date, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions, metrics.search_impression_share, metrics.search_click_share FROM campaign WHERE campaign.name = '${escGaql(campaign)}' AND ${dateClause}`;
    const results = await mapLimit(ids, 5, async (id) => {
      try { const r = await adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query: q }); return r.results || []; }
      catch (e) { errors.push("campaign: " + String(e && e.message ? e.message : e).slice(0, 160)); return []; }
    });
    for (const rows of results) {
      if (rows.length) accounts++;
      for (const row of rows) { const d = row.segments?.date, m = row.metrics; if (m) { addCore(d, m); addShare(d, m); } }
    }
  } else {
    // Account-level — FROM customer, core + share split so core survives share failure.
    const coreQuery = `SELECT segments.date, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM customer WHERE ${dateClause}`;
    const shareQuery = `SELECT segments.date, metrics.impressions, metrics.search_impression_share, metrics.search_click_share FROM customer WHERE ${dateClause}`;
    const results = await mapLimit(ids, 5, async (id) => {
      const out = { core: [], share: [] };
      try { const r = await adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query: coreQuery }); out.core = r.results || []; }
      catch (e) { errors.push("core: " + String(e && e.message ? e.message : e).slice(0, 160)); }
      try { const r = await adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query: shareQuery }); out.share = r.results || []; }
      catch (e) { errors.push("share: " + String(e && e.message ? e.message : e).slice(0, 160)); }
      return out;
    });
    for (const { core, share } of results) {
      if (core.length) accounts++;
      for (const row of core) { if (row.metrics) addCore(row.segments?.date, row.metrics); }
      for (const row of share) { if (row.metrics) addShare(row.segments?.date, row.metrics); }
    }
  }

  const series = Object.keys(byDate).sort().map((date) => Object.assign({ date }, byDate[date]));

  const payload = {
    clicks, impressions, cost, conversions, accounts,
    searchImpShare: shareWeight > 0 ? impShareW / shareWeight : null,
    searchClickShare: shareWeight > 0 ? clickShareW / shareWeight : null,
    series,
  };
  if (errors.length) payload._errors = errors.slice(0, 6);
  return json(payload);
}

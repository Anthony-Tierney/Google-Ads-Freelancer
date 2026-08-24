// GET /api/reporting?customerId=ALL|<id>&dateRange=<gaql date clause>
// Account-level totals for the Reporting scorecards.
// Core metrics and impression/click share are queried SEPARATELY so that if the share
// fields aren't valid FROM customer, the core scorecards still populate. Any query error
// is surfaced in _errors for debugging.
//   { clicks, impressions, cost, conversions, searchImpShare, searchClickShare, accounts, _errors? }

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

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId") || "ALL";
  const dateClause = url.searchParams.get("dateRange") || "segments.date DURING LAST_30_DAYS";

  const accessToken = await getAccessToken(env, refreshToken);

  let ids;
  if (customerId === "ALL") {
    const list = await adsRequest(env, accessToken, "customers:listAccessibleCustomers");
    ids = (list.resourceNames || []).map((rn) => rn.split("/")[1]);
  } else {
    ids = [customerId.replace(/-/g, "")];
  }

  const coreQuery = `SELECT metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM customer WHERE ${dateClause}`;
  const shareQuery = `SELECT metrics.impressions, metrics.search_impression_share, metrics.search_click_share FROM customer WHERE ${dateClause}`;

  const results = await mapLimit(ids, 5, async (id) => {
    const out = { core: null, share: null, err: [] };
    try {
      const r = await adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query: coreQuery });
      out.core = r.results?.[0]?.metrics || null;
    } catch (e) { out.err.push("core: " + String(e && e.message ? e.message : e).slice(0, 160)); }
    try {
      const r = await adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query: shareQuery });
      out.share = r.results?.[0]?.metrics || null;
    } catch (e) { out.err.push("share: " + String(e && e.message ? e.message : e).slice(0, 160)); }
    return out;
  });

  let clicks = 0, impressions = 0, cost = 0, conversions = 0;
  let impShareW = 0, clickShareW = 0, shareWeight = 0, accounts = 0;
  const errors = [];
  for (const row of results) {
    if (row.err.length) errors.push(...row.err);
    const m = row.core;
    if (!m) continue;
    accounts++;
    const imp = Number(m.impressions) || 0;
    clicks += Number(m.clicks) || 0;
    impressions += imp;
    cost += (Number(m.costMicros) || 0) / 1e6;
    conversions += Number(m.conversions) || 0;
    const s = row.share;
    if (s && imp > 0) {
      if (s.searchImpressionShare != null) { impShareW += Number(s.searchImpressionShare) * imp; shareWeight += imp; }
      if (s.searchClickShare != null) { clickShareW += Number(s.searchClickShare) * imp; }
    }
  }

  const payload = {
    clicks, impressions, cost, conversions, accounts,
    searchImpShare: shareWeight > 0 ? impShareW / shareWeight : null,
    searchClickShare: shareWeight > 0 ? clickShareW / shareWeight : null,
  };
  if (errors.length) payload._errors = errors.slice(0, 6);
  return json(payload);
}

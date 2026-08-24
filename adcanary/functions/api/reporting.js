// GET /api/reporting?customerId=ALL|<id>&dateRange=<gaql date clause>&campaign=<name>
// Scorecard totals for the Reporting page.
//   • No campaign  → account-level (FROM customer). Core metrics and impression/click
//     share are separate queries, so core still populates if share isn't valid
//     FROM customer.
//   • With campaign → campaign-level (FROM campaign WHERE campaign.name = ...). Impression
//     share IS valid here; if the campaign name occurs in several accounts they're summed
//     (share impressions-weighted).
//   Returns { clicks, impressions, cost, conversions, searchImpShare, searchClickShare, accounts, _errors? }

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

  const addMetrics = (m) => {
    const imp = Number(m.impressions) || 0;
    clicks += Number(m.clicks) || 0;
    impressions += imp;
    cost += (Number(m.costMicros) || 0) / 1e6;
    conversions += Number(m.conversions) || 0;
    if (m.searchImpressionShare != null && imp > 0) { impShareW += Number(m.searchImpressionShare) * imp; shareWeight += imp; }
    if (m.searchClickShare != null && imp > 0) { clickShareW += Number(m.searchClickShare) * imp; }
  };

  if (campaign) {
    // Campaign-level — FROM campaign supports impression share directly.
    const q = `SELECT metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions, metrics.search_impression_share, metrics.search_click_share FROM campaign WHERE campaign.name = '${escGaql(campaign)}' AND ${dateClause}`;
    const results = await mapLimit(ids, 5, async (id) => {
      try {
        const r = await adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query: q });
        return r.results || [];
      } catch (e) { errors.push("campaign: " + String(e && e.message ? e.message : e).slice(0, 160)); return []; }
    });
    for (const rows of results) {
      let matched = false;
      for (const row of rows) { if (row.metrics) { addMetrics(row.metrics); matched = true; } }
      if (matched) accounts++;
    }
  } else {
    // Account-level — FROM customer, core + share split so core survives share failure.
    const coreQuery = `SELECT metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM customer WHERE ${dateClause}`;
    const shareQuery = `SELECT metrics.impressions, metrics.search_impression_share, metrics.search_click_share FROM customer WHERE ${dateClause}`;
    const results = await mapLimit(ids, 5, async (id) => {
      const out = { core: null, share: null };
      try { const r = await adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query: coreQuery }); out.core = r.results?.[0]?.metrics || null; }
      catch (e) { errors.push("core: " + String(e && e.message ? e.message : e).slice(0, 160)); }
      try { const r = await adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query: shareQuery }); out.share = r.results?.[0]?.metrics || null; }
      catch (e) { errors.push("share: " + String(e && e.message ? e.message : e).slice(0, 160)); }
      return out;
    });
    for (const row of results) {
      const m = row.core; if (!m) continue;
      accounts++;
      const merged = { ...m };
      if (row.share) { merged.searchImpressionShare = row.share.searchImpressionShare; merged.searchClickShare = row.share.searchClickShare; }
      addMetrics(merged);
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

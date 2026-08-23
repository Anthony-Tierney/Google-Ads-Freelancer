// GET /api/reporting?customerId=ALL|<id>&dateRange=<gaql date clause>
// Account-level totals for the Reporting scorecards. Uses FROM customer so impression
// share / click share come back correctly (they can't be summed from campaigns).
// For ALL accounts: additive metrics are summed; impression/click share are
// impressions-weighted averages across accounts.
//   { clicks, impressions, cost, conversions, searchImpShare, searchClickShare, accounts }

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

  const query = `SELECT metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions, metrics.search_impression_share, metrics.search_click_share FROM customer WHERE ${dateClause}`;

  const rows = await mapLimit(ids, 5, async (id) => {
    try {
      const r = await adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query });
      return r.results?.[0]?.metrics || null;
    } catch {
      return null; // managers / no-access accounts just drop out
    }
  });

  let clicks = 0, impressions = 0, cost = 0, conversions = 0;
  let impShareW = 0, clickShareW = 0, shareWeight = 0, accounts = 0;
  for (const m of rows) {
    if (!m) continue;
    accounts++;
    const imp = Number(m.impressions) || 0;
    clicks += Number(m.clicks) || 0;
    impressions += imp;
    cost += (Number(m.costMicros) || 0) / 1e6;
    conversions += Number(m.conversions) || 0;
    if (m.searchImpressionShare != null && imp > 0) { impShareW += Number(m.searchImpressionShare) * imp; shareWeight += imp; }
    if (m.searchClickShare != null && imp > 0) { clickShareW += Number(m.searchClickShare) * imp; }
  }

  return json({
    clicks, impressions, cost, conversions, accounts,
    searchImpShare: shareWeight > 0 ? impShareW / shareWeight : null,
    searchClickShare: shareWeight > 0 ? clickShareW / shareWeight : null,
  });
}

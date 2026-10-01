// GET /api/cannibalization?customerId=<id>&dateRange=<gaql date clause>
// Flags search terms within ONE account that triggered 2+ campaigns over the range
// (campaigns cannibalising each other for the same queries).
//   { terms: [{ term, campaignCount, impressions, clicks, cost, conversions,
//               campaigns: [{ name, impressions, clicks, cost, conversions }] }] }
// Sorted by impressions desc; only terms with 2+ campaigns are returned.

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  if (!customerId || customerId === "ALL") return json({ error: "Select a single account" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  const drParam = url.searchParams.get("dateRange") || "LAST_30_DAYS";
  const drFixed = drParam.replace(/'(\d{4})(\d{2})(\d{2})'/g, "'$1-$2-$3'");
  const dateClause = /segments\.date/i.test(drFixed) ? drFixed : "segments.date DURING " + drFixed;

  const accessToken = await getAccessToken(env, refreshToken);

  try {
    const query = `SELECT search_term_view.search_term, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE ${dateClause}`;
    const result = await adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, { query });

    const byTerm = new Map(); // term -> Map(campaignName -> { name, impressions, clicks, cost, conversions })
    for (const r of result.results || []) {
      const term = r.searchTermView?.searchTerm;
      const camp = r.campaign?.name;
      if (!term || !camp) continue;
      const m = r.metrics || {};
      let camps = byTerm.get(term);
      if (!camps) { camps = new Map(); byTerm.set(term, camps); }
      let c = camps.get(camp);
      if (!c) { c = { name: camp, impressions: 0, clicks: 0, cost: 0, conversions: 0 }; camps.set(camp, c); }
      c.impressions += Number(m.impressions) || 0;
      c.clicks += Number(m.clicks) || 0;
      c.cost += (Number(m.costMicros) || 0) / 1e6;
      c.conversions += Number(m.conversions) || 0;
    }

    const terms = [];
    for (const [term, camps] of byTerm) {
      if (camps.size < 2) continue;
      const campaigns = [...camps.values()].sort((a, b) => b.impressions - a.impressions);
      const sum = (k) => campaigns.reduce((a, c) => a + c[k], 0);
      terms.push({ term, campaignCount: campaigns.length, impressions: sum("impressions"), clicks: sum("clicks"), cost: sum("cost"), conversions: sum("conversions"), campaigns });
    }
    terms.sort((a, b) => b.impressions - a.impressions);

    return json({ terms });
  } catch (e) {
    return json({ terms: [], error: "Could not load search terms", detail: String(e && e.message ? e.message : e).slice(0, 200) }, 200);
  }
}

// GET /api/suggestednegatives?customerId=<id>&dateRange=<ALL_TIME | GAQL macro | "segments.date >= ... AND ...">&minClicks=<n>
//
// Search terms for the Suggested Negatives page: one row per search term per campaign per
// ad group, with metrics over the range. Each row also says whether the term is blocked *now*:
//   blocked = "" (still able to show) or the reason — a current campaign / ad group / shared-list
//             negative that matches it, or the campaign / ad group no longer serving.
// Only terms whose total clicks across the account reach `minClicks` are returned (the page's
// "Minimum clicks" filter), which keeps large accounts fast; the page re-asks if it's lowered.
//
//   { rows: [{ term, campaignId, campaign, campaignStatus, adGroupId, adGroup, adGroupStatus,
//              impressions, clicks, cost, conversions, convValue, blocked }],
//     minClicks, truncated?, warning? }

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";
import { canAccess } from "../../shared/access.js";
import { loadNegatives } from "../../shared/negatives.js";

const STATUS = { ENABLED: "Enabled", PAUSED: "Paused", REMOVED: "Removed" };
const MAX_PAGES = 20; // 20 × 10,000 rows

export async function onRequestGet(context) {
  const { request, env } = context;
  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const cid = String(url.searchParams.get("customerId") || "").replace(/-/g, "");
  if (!cid || cid === "ALL") return json({ error: "Select a single account" }, 400);
  if (!(await canAccess(env, refreshToken, cid))) return json({ error: "You don't have access to this Google Ads account" }, 403);
  const minClicks = Math.max(0, parseInt(url.searchParams.get("minClicks"), 10) || 0);

  const dr = (url.searchParams.get("dateRange") || "ALL_TIME").replace(/'(\d{4})(\d{2})(\d{2})'/g, "'$1-$2-$3'");
  const allTime = dr === "ALL_TIME";
  const safeDr = /^[A-Z0-9_]+$/.test(dr) || /^segments\.date >= '\d{4}-\d{2}-\d{2}' AND segments\.date <= '\d{4}-\d{2}-\d{2}'$/.test(dr);
  if (!allTime && !safeDr) return json({ error: "Invalid date range" }, 400);
  const dateClause = allTime ? "" : (/segments\.date/.test(dr) ? " AND " + dr : " AND segments.date DURING " + dr);

  const accessToken = await getAccessToken(env, refreshToken);
  let truncated = false;
  const search = async (query) => {
    const out = []; let pageToken, pages = 0;
    do {
      const r = await adsRequest(env, accessToken, `customers/${cid}/googleAds:search`, pageToken ? { query, pageToken } : { query });
      out.push(...(r.results || [])); pageToken = r.nextPageToken;
    } while (pageToken && ++pages < MAX_PAGES);
    if (pageToken) truncated = true;
    return out;
  };

  const ST_FIELDS = `search_term_view.search_term, campaign.id, campaign.name, campaign.status, ad_group.id, ad_group.name, ad_group.status,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value`;
  const stQuery = (clause) => `SELECT ${ST_FIELDS} FROM search_term_view WHERE metrics.clicks > 0${clause}`;

  let stRows;
  const [stR, negR, endedR] = await Promise.allSettled([
    (async () => {
      try { return await search(stQuery(dateClause)); }
      catch (e) {
        // All Time: if Google wants an explicit range, ask from 2010 to today instead.
        if (!allTime) throw e;
        truncated = false;
        return await search(stQuery(` AND segments.date >= '2010-01-01' AND segments.date <= '${new Date().toISOString().slice(0, 10)}'`));
      }
    })(),
    loadNegatives(search),
    search(`SELECT campaign.id, campaign.serving_status FROM campaign WHERE campaign.status = 'ENABLED'`),
  ]);
  if (stR.status !== "fulfilled") {
    return json({ error: "Could not load search terms", detail: String(stR.reason?.message || stR.reason).slice(0, 300) }, 500);
  }
  stRows = stR.value;
  const negatives = negR.status === "fulfilled" ? negR.value : null;
  const ended = new Set();
  if (endedR.status === "fulfilled") endedR.value.forEach((r) => { if (r.campaign?.servingStatus === "ENDED") ended.add(String(r.campaign.id)); });

  // Keep only terms whose account-wide clicks reach minClicks.
  const termClicks = new Map();
  stRows.forEach((r) => { const t = r.searchTermView?.searchTerm; if (t) termClicks.set(t, (termClicks.get(t) || 0) + (Number(r.metrics?.clicks) || 0)); });

  // One row per term × ad group (a term can also appear under several match types — summed).
  const byKey = new Map();
  for (const r of stRows) {
    const term = r.searchTermView?.searchTerm;
    if (!term || (termClicks.get(term) || 0) < minClicks) continue;
    const campaignId = String(r.campaign?.id || ""), adGroupId = String(r.adGroup?.id || "");
    const key = term + "\u0001" + adGroupId;
    let row = byKey.get(key);
    if (!row) {
      const cs = r.campaign?.status, campaignStatus = cs === "ENABLED" && ended.has(campaignId) ? "Ended" : (STATUS[cs] || cs || "");
      const adGroupStatus = STATUS[r.adGroup?.status] || r.adGroup?.status || "";
      let blocked = "";
      if (campaignStatus !== "Enabled") blocked = "Campaign " + campaignStatus.toLowerCase();
      else if (adGroupStatus !== "Enabled") blocked = "Ad group " + adGroupStatus.toLowerCase();
      else if (negatives) blocked = negatives.negativeFor(term, campaignId, adGroupId);
      row = { term, campaignId, campaign: r.campaign?.name || "", campaignStatus, adGroupId, adGroup: r.adGroup?.name || "", adGroupStatus,
        impressions: 0, clicks: 0, cost: 0, conversions: 0, convValue: 0, blocked };
      byKey.set(key, row);
    }
    const m = r.metrics || {};
    row.impressions += Number(m.impressions) || 0;
    row.clicks += Number(m.clicks) || 0;
    row.cost += (Number(m.costMicros) || 0) / 1e6;
    row.conversions += Number(m.conversions) || 0;
    row.convValue += Number(m.conversionsValue) || 0;
  }

  const payload = { rows: [...byKey.values()], minClicks };
  const warnings = [];
  if (truncated) warnings.push("This account has more search terms than can be read in one go — the busiest ones may be missing. Try a shorter date range.");
  if (!negatives) warnings.push("Couldn't read the account's negative keywords, so nothing is marked as blocked.");
  else if (negatives.errors.length) warnings.push("Couldn't read some negatives (" + negatives.errors.join(", ") + "), so a few blocked terms may show as not blocked.");
  if (warnings.length) payload.warning = warnings.join(" ");
  if (truncated) payload.truncated = true;
  return json(payload);
}

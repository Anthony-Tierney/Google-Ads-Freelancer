// GET /api/ngrams?customerId=<id>&dateRange=<GAQL macro | "segments.date >= ... AND ...">[&campaignId=<id>]
//
// N-gram report for the Keywords & Negatives page. Search terms over the range (optionally one
// campaign) are split into 1-, 2- and 3-word phrases; each phrase gets the summed metrics of every
// search term containing it (a phrase counts once per term, even if it appears twice in it).
//
//   { ngrams: [{ g, n, terms, impressions, clicks, cost, conversions, convValue, ex: [top terms by cost] }],
//     campaigns: [{ id, name, status }], termCount, truncated?, warning? }
//
// Rows are read page by page and folded into per-term totals as they arrive, so big accounts don't
// run the server out of memory; reading stops after MAX_PAGES and the reply says it's incomplete.
// Each size keeps its top MAX_PER_SIZE phrases by cost, then impressions.

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";
import { canAccess } from "../../shared/access.js";

const MAX_PAGES = 15; // × 10,000 rows
const MAX_PER_SIZE = 8000;
const STATUS = { ENABLED: "Enabled", PAUSED: "Paused", REMOVED: "Removed" };

export async function onRequestGet(context) {
  const { request, env } = context;
  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const cid = String(url.searchParams.get("customerId") || "").replace(/-/g, "");
  if (!cid || cid === "ALL") return json({ error: "Select a single account" }, 400);
  if (!(await canAccess(env, refreshToken, cid))) return json({ error: "You don't have access to this Google Ads account" }, 403);

  const dr = (url.searchParams.get("dateRange") || "LAST_30_DAYS").replace(/'(\d{4})(\d{2})(\d{2})'/g, "'$1-$2-$3'");
  const explicit = /^segments\.date >= '\d{4}-\d{2}-\d{2}' AND segments\.date <= '\d{4}-\d{2}-\d{2}'$/.test(dr);
  if (!explicit && !/^[A-Z0-9_]+$/.test(dr)) return json({ error: "Invalid date range" }, 400);
  const dateClause = explicit ? dr : "segments.date DURING " + dr;
  const campaignId = /^\d{1,15}$/.test(url.searchParams.get("campaignId") || "") ? url.searchParams.get("campaignId") : "";

  const accessToken = await getAccessToken(env, refreshToken);
  const page = (query, pageToken) => adsRequest(env, accessToken, `customers/${cid}/googleAds:search`, pageToken ? { query, pageToken } : { query });

  // 1) Search terms → per-term totals.
  const byTerm = new Map();
  let truncated = false;
  try {
    const q = `SELECT search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
      FROM search_term_view WHERE ${dateClause} AND metrics.impressions > 0${campaignId ? ` AND campaign.id = ${campaignId}` : ""}`;
    let pageToken, pages = 0;
    do {
      const r = await page(q, pageToken);
      for (const row of r.results || []) {
        const term = String(row.searchTermView?.searchTerm || "").toLowerCase().replace(/\s+/g, " ").trim();
        if (!term) continue;
        const m = row.metrics || {};
        let t = byTerm.get(term);
        if (!t) { t = { impressions: 0, clicks: 0, cost: 0, conversions: 0, convValue: 0 }; byTerm.set(term, t); }
        t.impressions += Number(m.impressions) || 0;
        t.clicks += Number(m.clicks) || 0;
        t.cost += (Number(m.costMicros) || 0) / 1e6;
        t.conversions += Number(m.conversions) || 0;
        t.convValue += Number(m.conversionsValue) || 0;
      }
      pageToken = r.nextPageToken;
    } while (pageToken && ++pages < MAX_PAGES);
    truncated = !!pageToken;
  } catch (e) {
    return json({ error: "Could not load search terms", detail: String(e?.message || e).slice(0, 300) }, 500);
  }

  // 2) Terms → 1-, 2- and 3-word phrases.
  const grams = [new Map(), new Map(), new Map()];
  for (const [term, t] of byTerm) {
    const w = term.split(" ");
    for (let n = 1; n <= 3; n++) {
      const seen = new Set();
      for (let i = 0; i + n <= w.length; i++) {
        const g = w.slice(i, i + n).join(" ");
        if (seen.has(g)) continue;
        seen.add(g);
        let a = grams[n - 1].get(g);
        if (!a) { a = { g, n, terms: 0, impressions: 0, clicks: 0, cost: 0, conversions: 0, convValue: 0, ex: [] }; grams[n - 1].set(g, a); }
        a.terms++; a.impressions += t.impressions; a.clicks += t.clicks; a.cost += t.cost; a.conversions += t.conversions; a.convValue += t.convValue;
        // Keep the 3 costliest example terms.
        if (a.ex.length < 3 || t.cost > a.ex[a.ex.length - 1][1]) {
          a.ex.push([term, t.cost]); a.ex.sort((x, y) => y[1] - x[1]); if (a.ex.length > 3) a.ex.pop();
        }
      }
    }
  }
  let capped = false;
  const ngrams = [];
  const round = (x) => Math.round(x * 100) / 100;
  for (const map of grams) {
    let list = [...map.values()];
    if (list.length > MAX_PER_SIZE) { capped = true; list.sort((a, b) => b.cost - a.cost || b.impressions - a.impressions); list = list.slice(0, MAX_PER_SIZE); }
    for (const a of list) ngrams.push({ ...a, cost: round(a.cost), conversions: round(a.conversions), convValue: round(a.convValue), ex: a.ex.map((e) => e[0]) });
  }

  // 3) Campaigns for the picker.
  let campaigns = [];
  try {
    const r = await page(`SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status FROM campaign WHERE campaign.status != 'REMOVED' AND campaign.advertising_channel_type IN ('SEARCH', 'PERFORMANCE_MAX')`);
    campaigns = (r.results || []).map((x) => ({ id: String(x.campaign?.id || ""), name: x.campaign?.name || "",
      status: x.campaign?.status === "ENABLED" && x.campaign?.servingStatus === "ENDED" ? "Ended" : (STATUS[x.campaign?.status] || "") }));
  } catch { /* the picker falls back to what it already knows */ }

  const payload = { ngrams, campaigns, termCount: byTerm.size };
  const warnings = [];
  if (truncated) warnings.push("This account has more search terms than can be read in one go for this date range, so the figures leave some out. Choose a shorter date range or a single campaign for complete figures.");
  if (capped) warnings.push("Only the top " + MAX_PER_SIZE.toLocaleString("en-GB") + " phrases of each size (by cost) are shown.");
  if (truncated) payload.truncated = true;
  if (warnings.length) payload.warning = warnings.join(" ");
  return json(payload);
}

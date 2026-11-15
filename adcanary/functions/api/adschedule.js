// GET /api/adschedule?customerId=<id>&dateRange=<GAQL macro | "segments.date >= ... AND ...">
//
// Performance by day of the week and hour of the day for the Ad Scheduling page, one row per
// campaign × day × hour (hours are in the account's time zone, as in Google Ads). The page sums
// these into Day, Hour or Day & hour, for all campaigns or the one picked in the top bar.
//
//   { rows: [{ campaignId, campaign, campaignStatus, day: "MONDAY", hour: 0-23,
//              impressions, clicks, cost, conversions, convValue }] }

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";
import { canAccess } from "../../shared/access.js";

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

  const query = `SELECT campaign.id, campaign.name, campaign.status, segments.day_of_week, segments.hour,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value
    FROM campaign WHERE ${dateClause} AND metrics.impressions > 0`;

  try {
    const accessToken = await getAccessToken(env, refreshToken);
    const results = [];
    let pageToken, pages = 0;
    do {
      const r = await adsRequest(env, accessToken, `customers/${cid}/googleAds:search`, pageToken ? { query, pageToken } : { query });
      results.push(...(r.results || []));
      pageToken = r.nextPageToken;
    } while (pageToken && ++pages < 20);

    const rows = results.map((r) => {
      const m = r.metrics || {};
      return {
        campaignId: String(r.campaign?.id || ""),
        campaign: r.campaign?.name || "",
        campaignStatus: STATUS[r.campaign?.status] || r.campaign?.status || "",
        day: r.segments?.dayOfWeek || "",
        hour: Number(r.segments?.hour) || 0,
        impressions: Number(m.impressions) || 0,
        clicks: Number(m.clicks) || 0,
        cost: (Number(m.costMicros) || 0) / 1e6,
        conversions: Number(m.conversions) || 0,
        convValue: Number(m.conversionsValue) || 0,
      };
    }).filter((r) => r.day);
    return json({ rows });
  } catch (e) {
    return json({ error: "Could not load ad schedule data", detail: String(e?.message || e).slice(0, 300) }, 500);
  }
}

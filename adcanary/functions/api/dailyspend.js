// GET /api/dailyspend?customerId=1234567890
// Per-day account cost for the last 30 days (all non-removed campaigns), used by the
// Budget Pacing "Projected (this month)" chart to draw actual daily spend and to derive
// the day-of-week spend pattern for the projection.
//   { days: [{ date: "YYYY-MM-DD", cost }] }  (sorted ascending)

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return json({ error: "Missing customerId" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  const accessToken = await getAccessToken(env, refreshToken);

  try {
    const result = await adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, {
      query: "SELECT segments.date, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.status != 'REMOVED'",
    });
    const byDate = {};
    for (const r of result.results || []) {
      const d = r.segments?.date;
      if (!d) continue;
      byDate[d] = (byDate[d] || 0) + Number(r.metrics?.costMicros || 0) / 1e6;
    }
    const days = Object.keys(byDate).sort().map((date) => ({ date, cost: byDate[date] }));
    return json({ days });
  } catch (e) {
    return json({ days: [], error: (e && e.message) ? e.message : String(e) });
  }
}

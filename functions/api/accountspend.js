// GET /api/accountspend?customerId=1234567890
// Total account cost for the previous calendar month (LAST_MONTH), across ALL
// campaigns — enabled, paused and removed — via an account-level (FROM customer)
// query so nothing is filtered out. Returns { lastMonthSpend } in currency units.

import {
  getRefreshToken,
  getAccessToken,
  adsRequest,
  json,
} from "../../shared/google.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return json({ error: "Missing customerId" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  const accessToken = await getAccessToken(env, refreshToken);

  try {
    const result = await adsRequest(
      env,
      accessToken,
      `customers/${cleanId}/googleAds:search`,
      { query: "SELECT metrics.cost_micros FROM customer WHERE segments.date DURING LAST_MONTH" }
    );
    let cost = 0;
    for (const r of result.results || []) cost += Number(r.metrics?.costMicros || 0) / 1e6;
    return json({ lastMonthSpend: cost });
  } catch (e) {
    // Managers have no metrics; anything else we just report as null so the card shows "—".
    return json({ lastMonthSpend: null, error: (e && e.message) ? e.message : String(e) });
  }
}

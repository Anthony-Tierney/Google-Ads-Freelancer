// GET /api/bidding?customerId=1234567890
// For each non-removed campaign: bidding strategy, target CPA (if any), and the CPA
// achieved over the last 14 days (excluding today, per LAST_14_DAYS).
//   { campaigns: [{ id, name, status, type, biddingStrategy, targetCpa, cpaAchieved }], metricError }

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
  const search = (query) =>
    adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, { query });

  const [campR, metricR] = await Promise.allSettled([
    search(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.status != 'REMOVED'`),
    // LAST_14_DAYS excludes today; aggregated (no segments.date) gives 14-day totals.
    search(`SELECT campaign.id, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_14_DAYS AND campaign.status != 'REMOVED'`),
  ]);

  if (campR.status !== "fulfilled") {
    const e = campR.reason;
    return json({ error: (e && e.message) ? e.message : "Could not load campaigns" }, 500);
  }

  const campaigns = {};
  (campR.value.results || []).forEach((r) => {
    const id = String(r.campaign?.id);
    const targetMicros =
      r.campaign?.targetCpa?.targetCpaMicros ??
      r.campaign?.maximizeConversions?.targetCpaMicros ??
      null;
    campaigns[id] = {
      id,
      name: r.campaign?.name,
      status: r.campaign?.status,
      type: r.campaign?.advertisingChannelType,
      biddingStrategy: r.campaign?.biddingStrategyType,
      targetCpa: targetMicros != null ? Number(targetMicros) / 1e6 : null,
      cost: 0,
      conversions: 0,
    };
  });

  let metricError = null;
  if (metricR.status === "fulfilled") {
    (metricR.value.results || []).forEach((r) => {
      const c = campaigns[String(r.campaign?.id)];
      if (!c) return;
      c.cost = Number(r.metrics?.costMicros || 0) / 1e6;
      c.conversions = Number(r.metrics?.conversions || 0);
    });
  } else {
    const e = metricR.reason;
    metricError = (e && e.message) ? e.message : "Could not load performance";
  }

  const out = Object.values(campaigns).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    type: c.type,
    biddingStrategy: c.biddingStrategy,
    targetCpa: c.targetCpa,
    cpaAchieved: c.conversions > 0 ? c.cost / c.conversions : null,
  }));

  return json({ campaigns: out, metricError });
}

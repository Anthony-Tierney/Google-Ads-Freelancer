// GET /api/campaigns?customerId=1234567890&dateRange=LAST_30_DAYS
// Returns campaign metrics for the chosen account and date range.

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

  const dateRange = new URL(request.url).searchParams.get("dateRange") || "LAST_30_DAYS";

  const accessToken = await getAccessToken(env, refreshToken);

  const query = `
    SELECT
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date DURING ${dateRange}
    ORDER BY metrics.clicks DESC`;

  const result = await adsRequest(
    env,
    accessToken,
    `customers/${cleanId}/googleAds:search`,
    { query }
  );

  const campaigns = (result.results || []).map((r, i) => ({
    id: String(i),
    name: r.campaign?.name,
    status: r.campaign?.status,
    channelType: r.campaign?.advertisingChannelType,
    budget: Number(r.campaignBudget?.amountMicros || 0) / 1e6,
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    cost: Number(r.metrics?.costMicros || 0) / 1e6,
    conversions: Number(r.metrics?.conversions || 0),
    convValue: Number(r.metrics?.conversionsValue || 0),
  }));

  return json({ campaigns });
}

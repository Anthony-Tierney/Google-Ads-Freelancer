// GET /api/campaigns?customerId=1234567890
// Returns last-30-days campaign metrics for the chosen account, shaped to match
// the CampaignTable frontend (it derives CTR, CPC, conv. rate, CPA, ROAS itself).

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
  const cleanId = customerId.replace(/-/g, ""); // strip hyphens if present

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
    WHERE segments.date DURING LAST_30_DAYS
    ORDER BY metrics.cost_micros DESC`;

  const result = await adsRequest(
    env,
    accessToken,
    `customers/${cleanId}/googleAds:search`,
    { query }
  );

  // The REST response uses camelCase field names. Micros are millionths, so
  // divide cost/budget by 1,000,000 to get currency units.
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

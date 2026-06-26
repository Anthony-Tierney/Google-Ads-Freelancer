// GET /api/landingpages?customerId=1234567890
// Returns the live final URLs (landing pages) that served in the last 30 days,
// grouped by campaign, with clicks, CTR and conversion rate for each URL:
//   { rows: [{ campaignId, name, status, finalUrl, clicks, ctr, convRate }] }

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
    const res = await adsRequest(
      env,
      accessToken,
      `customers/${cleanId}/googleAds:search`,
      {
        query: `
          SELECT
            campaign.id,
            campaign.name,
            campaign.status,
            landing_page_view.unexpanded_final_url,
            metrics.clicks,
            metrics.ctr,
            metrics.conversions_from_interactions_rate
          FROM landing_page_view
          WHERE segments.date DURING LAST_30_DAYS
            AND campaign.status != 'REMOVED'
            AND metrics.impressions > 0
          ORDER BY metrics.clicks DESC`,
      }
    );

    const rows = (res.results || [])
      .map((r) => ({
        campaignId: String(r.campaign?.id || ""),
        name: r.campaign?.name || "",
        status: r.campaign?.status || "",
        finalUrl: r.landingPageView?.unexpandedFinalUrl || "",
        clicks: Number(r.metrics?.clicks) || 0,
        ctr: Number(r.metrics?.ctr) || 0,
        convRate: Number(r.metrics?.conversionsFromInteractionsRate) || 0,
      }))
      .filter((r) => r.finalUrl);

    return json({ rows });
  } catch (e) {
    return json(
      { error: (e && e.message) ? e.message : "Could not load landing pages" },
      500
    );
  }
}

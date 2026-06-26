// GET /api/landingpages?customerId=1234567890
// Lists the final URLs configured on ENABLED ads inside ENABLED campaigns,
// regardless of whether they've served recently (so a campaign that was paused
// last month but is live now still shows its URLs). Clicks / CTR / conversion
// rate are a best-effort overlay for the last 30 days — 0 when a URL hasn't
// served in that window.
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
    // 1) Config — every enabled ad in an enabled campaign, with its final URL(s).
    //    No date range, so ads that haven't served recently are still included.
    const cfg = await adsRequest(
      env,
      accessToken,
      `customers/${cleanId}/googleAds:search`,
      {
        query: `
          SELECT
            campaign.id,
            campaign.name,
            ad_group_ad.ad.id,
            ad_group_ad.ad.final_urls
          FROM ad_group_ad
          WHERE campaign.status = 'ENABLED'
            AND ad_group_ad.status = 'ENABLED'`,
      }
    );

    // (campaignId|url) -> aggregated row ; adId -> set of url keys it feeds.
    const byUrl = new Map();
    const adToKeys = new Map();
    (cfg.results || []).forEach((r) => {
      const campaignId = String(r.campaign?.id || "");
      const name = r.campaign?.name || "";
      const adId = String(r.adGroupAd?.ad?.id || "");
      const urls = r.adGroupAd?.ad?.finalUrls || [];
      urls.forEach((u) => {
        if (!u) return;
        const key = campaignId + "|" + u;
        if (!byUrl.has(key)) {
          byUrl.set(key, {
            campaignId,
            name,
            status: "ENABLED",
            finalUrl: u,
            clicks: 0,
            impressions: 0,
            conversions: 0,
          });
        }
        if (!adToKeys.has(adId)) adToKeys.set(adId, new Set());
        adToKeys.get(adId).add(key);
      });
    });

    // 2) Metrics over the last 30 days, aggregated per ad. Ads with no recent
    //    activity simply don't appear here, leaving their URL rows at zero.
    //    Best-effort: a failure here must not drop the URL list.
    try {
      const met = await adsRequest(
        env,
        accessToken,
        `customers/${cleanId}/googleAds:search`,
        {
          query: `
            SELECT
              ad_group_ad.ad.id,
              metrics.clicks,
              metrics.impressions,
              metrics.conversions
            FROM ad_group_ad
            WHERE campaign.status = 'ENABLED'
              AND ad_group_ad.status = 'ENABLED'
              AND segments.date DURING LAST_30_DAYS`,
        }
      );
      (met.results || []).forEach((r) => {
        const adId = String(r.adGroupAd?.ad?.id || "");
        const keys = adToKeys.get(adId);
        if (!keys) return;
        const clicks = Number(r.metrics?.clicks) || 0;
        const impressions = Number(r.metrics?.impressions) || 0;
        const conversions = Number(r.metrics?.conversions) || 0;
        keys.forEach((key) => {
          const row = byUrl.get(key);
          if (!row) return;
          row.clicks += clicks;
          row.impressions += impressions;
          row.conversions += conversions;
        });
      });
    } catch {
      /* metrics are best-effort; keep the URL list even if this query fails */
    }

    const rows = [...byUrl.values()].map((r) => ({
      campaignId: r.campaignId,
      name: r.name,
      status: r.status,
      finalUrl: r.finalUrl,
      clicks: r.clicks,
      ctr: r.impressions ? r.clicks / r.impressions : 0,
      convRate: r.clicks ? r.conversions / r.clicks : 0,
    }));

    return json({ rows });
  } catch (e) {
    return json(
      { error: (e && e.message) ? e.message : "Could not load landing pages" },
      500
    );
  }
}

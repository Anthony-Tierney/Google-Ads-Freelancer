// GET /api/landingpages?customerId=1234567890
// Lists the final URLs that are configured on live placements, independent of
// whether they've served recently:
//   • Ad-based campaigns (Search, Display, Shopping, Video, App, Demand Gen):
//     final URLs on ENABLED ads, in ENABLED ad groups, in ENABLED campaigns.
//   • Performance Max: final URLs on ENABLED asset groups in ENABLED campaigns
//     (the asset group is PMax's analogue of an ad group).
// Clicks / CTR / conversion rate are a best-effort overlay for the last 30 days
// (0 when a URL hasn't served in that window).
//   { rows: [{ campaignId, name, status, finalUrl, clicks, ctr, convRate }], warning? }

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

  // (campaignId|url) -> aggregated row ; entity ("ad:123"/"ag:456") -> set of url keys.
  const byUrl = new Map();
  const entityToKeys = new Map();
  const addUrl = (campaignId, name, url, entityId) => {
    if (!url) return;
    const key = campaignId + "|" + url;
    if (!byUrl.has(key)) {
      byUrl.set(key, {
        campaignId,
        name,
        status: "ENABLED",
        finalUrl: url,
        clicks: 0,
        impressions: 0,
        conversions: 0,
      });
    }
    if (!entityToKeys.has(entityId)) entityToKeys.set(entityId, new Set());
    entityToKeys.get(entityId).add(key);
  };
  const applyMetrics = (entityId, m) => {
    const keys = entityToKeys.get(entityId);
    if (!keys) return;
    const clicks = Number(m?.clicks) || 0;
    const impressions = Number(m?.impressions) || 0;
    const conversions = Number(m?.conversions) || 0;
    keys.forEach((key) => {
      const row = byUrl.get(key);
      if (!row) return;
      row.clicks += clicks;
      row.impressions += impressions;
      row.conversions += conversions;
    });
  };

  let adErr = null;
  let agErr = null;

  // 1a) Ad-based config — enabled ad / ad group / campaign. No date range, so ads
  //     that haven't served recently are still included.
  try {
    const cfg = await search(`
      SELECT
        campaign.id,
        campaign.name,
        ad_group_ad.ad.id,
        ad_group_ad.ad.final_urls
      FROM ad_group_ad
      WHERE campaign.status = 'ENABLED'
        AND ad_group.status = 'ENABLED'
        AND ad_group_ad.status = 'ENABLED'`);
    (cfg.results || []).forEach((r) => {
      const cid = String(r.campaign?.id || "");
      const name = r.campaign?.name || "";
      const entity = "ad:" + String(r.adGroupAd?.ad?.id || "");
      (r.adGroupAd?.ad?.finalUrls || []).forEach((u) => addUrl(cid, name, u, entity));
    });
  } catch (e) {
    adErr = (e && e.message) ? e.message : "Could not load ad URLs";
  }

  // 1b) Performance Max config — enabled asset group in an enabled campaign.
  try {
    const cfg = await search(`
      SELECT
        campaign.id,
        campaign.name,
        asset_group.id,
        asset_group.final_urls
      FROM asset_group
      WHERE campaign.status = 'ENABLED'
        AND asset_group.status = 'ENABLED'`);
    (cfg.results || []).forEach((r) => {
      const cid = String(r.campaign?.id || "");
      const name = r.campaign?.name || "";
      const entity = "ag:" + String(r.assetGroup?.id || "");
      (r.assetGroup?.finalUrls || []).forEach((u) => addUrl(cid, name, u, entity));
    });
  } catch (e) {
    agErr = (e && e.message) ? e.message : "Could not load Performance Max URLs";
  }

  // If neither source could be read, surface a hard error.
  if (adErr && agErr) return json({ error: adErr }, 500);

  // 2a) Ad metrics over the last 30 days (best-effort).
  try {
    const met = await search(`
      SELECT
        ad_group_ad.ad.id,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions
      FROM ad_group_ad
      WHERE campaign.status = 'ENABLED'
        AND ad_group.status = 'ENABLED'
        AND ad_group_ad.status = 'ENABLED'
        AND segments.date DURING LAST_30_DAYS`);
    (met.results || []).forEach((r) =>
      applyMetrics("ad:" + String(r.adGroupAd?.ad?.id || ""), r.metrics)
    );
  } catch {
    /* metrics are best-effort */
  }

  // 2b) Performance Max asset-group metrics over the last 30 days (best-effort).
  try {
    const met = await search(`
      SELECT
        asset_group.id,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions
      FROM asset_group
      WHERE campaign.status = 'ENABLED'
        AND asset_group.status = 'ENABLED'
        AND segments.date DURING LAST_30_DAYS`);
    (met.results || []).forEach((r) =>
      applyMetrics("ag:" + String(r.assetGroup?.id || ""), r.metrics)
    );
  } catch {
    /* metrics are best-effort */
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

  const warning = adErr
    ? "Some ad-based URLs couldn't be read: " + adErr
    : agErr
    ? "Some Performance Max URLs couldn't be read: " + agErr
    : undefined;

  return json({ rows, warning });
}

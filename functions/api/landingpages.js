// GET /api/landingpages?customerId=1234567890
// Lists final URLs on live placements, independent of recent serving:
//   • Ad-based campaigns (Search, Display, Shopping, Video, App, Demand Gen):
//     final URLs on ENABLED ads, in ENABLED ad groups, in ENABLED campaigns.   (source "Ad")
//   • Performance Max: final URLs on ENABLED asset groups in ENABLED campaigns. (source "Asset Group")
//   • Account-level sitelinks: final URLs on ENABLED customer-level SITELINK
//     assets, which apply to every campaign.                                    (source "Sitelink")
// Clicks / CTR / conversion rate are a best-effort overlay for the last 30 days
// (0 when a placement hasn't served in that window).
//   { rows: [{ name, adGroup, source, finalUrl, clicks, ctr, convRate }], warning? }

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

  // url-key -> aggregated row ; entity ("ad:1"/"ag:2"/"ca:3") -> set of url keys.
  const byUrl = new Map();
  const entityToKeys = new Map();
  const addUrl = (key, row, entityId) => {
    if (!key) return;
    if (!byUrl.has(key)) byUrl.set(key, { ...row, clicks: 0, impressions: 0, conversions: 0 });
    if (entityId) {
      if (!entityToKeys.has(entityId)) entityToKeys.set(entityId, new Set());
      entityToKeys.get(entityId).add(key);
    }
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

  const failures = [];

  // 1a) Ad-based config — enabled ad / ad group / campaign.
  try {
    const cfg = await search(`
      SELECT
        campaign.id,
        campaign.name,
        ad_group.id,
        ad_group.name,
        ad_group_ad.ad.id,
        ad_group_ad.ad.final_urls
      FROM ad_group_ad
      WHERE campaign.status = 'ENABLED'
        AND ad_group.status = 'ENABLED'
        AND ad_group_ad.status = 'ENABLED'`);
    (cfg.results || []).forEach((r) => {
      const cid = String(r.campaign?.id || "");
      const cname = r.campaign?.name || "";
      const agId = String(r.adGroup?.id || "");
      const agName = r.adGroup?.name || "";
      const entity = "ad:" + String(r.adGroupAd?.ad?.id || "");
      (r.adGroupAd?.ad?.finalUrls || []).forEach((u) => {
        if (!u) return;
        addUrl("Ad|" + cid + "|" + agId + "|" + u, { name: cname, adGroup: agName, source: "Ad", finalUrl: u }, entity);
      });
    });
  } catch (e) {
    failures.push("ad URLs (" + ((e && e.message) ? e.message : "failed") + ")");
  }

  // 1b) Performance Max config — enabled asset group in an enabled campaign.
  try {
    const cfg = await search(`
      SELECT
        campaign.id,
        campaign.name,
        asset_group.id,
        asset_group.name,
        asset_group.final_urls
      FROM asset_group
      WHERE campaign.status = 'ENABLED'
        AND asset_group.status = 'ENABLED'`);
    (cfg.results || []).forEach((r) => {
      const cid = String(r.campaign?.id || "");
      const cname = r.campaign?.name || "";
      const agId = String(r.assetGroup?.id || "");
      const agName = r.assetGroup?.name || "";
      const entity = "ag:" + agId;
      (r.assetGroup?.finalUrls || []).forEach((u) => {
        if (!u) return;
        addUrl("AG|" + cid + "|" + agId + "|" + u, { name: cname, adGroup: agName, source: "Asset Group", finalUrl: u }, entity);
      });
    });
  } catch (e) {
    failures.push("Performance Max URLs (" + ((e && e.message) ? e.message : "failed") + ")");
  }

  // 1c) Account-level sitelinks — enabled customer-level SITELINK assets. These
  //     apply to every campaign, so they're listed once as "All Campaigns".
  try {
    const cfg = await search(`
      SELECT
        customer_asset.asset,
        asset.final_urls
      FROM customer_asset
      WHERE customer_asset.field_type = 'SITELINK'
        AND customer_asset.status = 'ENABLED'`);
    (cfg.results || []).forEach((r) => {
      const assetId = String(r.customerAsset?.asset || "").split("/").pop();
      const entity = "ca:" + assetId;
      (r.asset?.finalUrls || []).forEach((u) => {
        if (!u) return;
        addUrl("SL|" + u, { name: "All Campaigns", adGroup: "", source: "Sitelink", finalUrl: u }, entity);
      });
    });
  } catch (e) {
    failures.push("account-level sitelink URLs (" + ((e && e.message) ? e.message : "failed") + ")");
  }

  // If nothing could be read at all, surface a hard error.
  if (failures.length === 3) return json({ error: failures[0] }, 500);

  // 2) Metrics overlays — last 30 days, aggregated per entity (all best-effort).
  try {
    const met = await search(`
      SELECT ad_group_ad.ad.id, metrics.clicks, metrics.impressions, metrics.conversions
      FROM ad_group_ad
      WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED'
        AND segments.date DURING LAST_30_DAYS`);
    (met.results || []).forEach((r) => applyMetrics("ad:" + String(r.adGroupAd?.ad?.id || ""), r.metrics));
  } catch { /* best-effort */ }

  try {
    const met = await search(`
      SELECT asset_group.id, metrics.clicks, metrics.impressions, metrics.conversions
      FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'
        AND segments.date DURING LAST_30_DAYS`);
    (met.results || []).forEach((r) => applyMetrics("ag:" + String(r.assetGroup?.id || ""), r.metrics));
  } catch { /* best-effort */ }

  try {
    const met = await search(`
      SELECT customer_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions
      FROM customer_asset
      WHERE customer_asset.field_type = 'SITELINK'
        AND segments.date DURING LAST_30_DAYS`);
    (met.results || []).forEach((r) => applyMetrics("ca:" + String(r.customerAsset?.asset || "").split("/").pop(), r.metrics));
  } catch { /* best-effort */ }

  const rows = [...byUrl.values()].map((r) => ({
    name: r.name,
    adGroup: r.adGroup,
    source: r.source,
    finalUrl: r.finalUrl,
    clicks: r.clicks,
    ctr: r.impressions ? r.clicks / r.impressions : 0,
    convRate: r.clicks ? r.conversions / r.clicks : 0,
  }));

  const warning = failures.length ? "Some URLs couldn't be read: " + failures.join("; ") : undefined;
  return json({ rows, warning });
}

// GET /api/landingpages?customerId=1234567890
// Lists final URLs on live placements, independent of recent serving:
//   • Ads (Search, Display, Shopping, Video, App, Demand Gen): enabled ad / ad group / campaign  → "Ad"
//   • Performance Max: enabled asset group in enabled campaign                                   → "Asset Group"
//   • Sitelink / Promotion / Price assets at account / campaign / ad-group level (enabled link)  → "Sitelink" / "Promotion" / "Price"
//     - Sitelink & Promotion URLs come from asset.final_urls.
//     - Price URLs come from each price offering's final_url, read from a separate `asset` query
//       (price_offerings can't be selected alongside campaign/ad_group fields) and joined by asset id.
//       Account-level assets show once as "All Campaigns".
// Clicks / CTR / conversion rate are a best-effort overlay for the last 30 days (0 when not served lately).
//   { rows: [{ name, adGroup, source, finalUrl, clicks, ctr, convRate }], warning? }

import {
  getRefreshToken,
  getAccessToken,
  adsRequest,
  json,
} from "../../shared/google.js";

const LINK_FIELD_TYPES = "('SITELINK','PROMOTION')"; // price handled separately (see below)
const METRIC_FIELD_TYPES = "('SITELINK','PROMOTION','PRICE')";

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
  const assetId = (rn) => String(rn || "").split("/").pop();

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

  // ---------- core config: ads, PMax, sitelink/promotion (one query each, parallel) ----------
  const cfgQueries = [
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.final_urls
       FROM ad_group_ad
      WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED'`,
    `SELECT campaign.id, campaign.name, asset_group.id, asset_group.name, asset_group.final_urls
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
    `SELECT customer_asset.asset, customer_asset.field_type, asset.final_urls
       FROM customer_asset
      WHERE customer_asset.field_type IN ${LINK_FIELD_TYPES} AND customer_asset.status = 'ENABLED'`,
    `SELECT campaign.id, campaign.name, campaign_asset.asset, campaign_asset.field_type, asset.final_urls
       FROM campaign_asset
      WHERE campaign_asset.field_type IN ${LINK_FIELD_TYPES} AND campaign_asset.status = 'ENABLED' AND campaign.status = 'ENABLED'`,
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_asset.asset, ad_group_asset.field_type, asset.final_urls
       FROM ad_group_asset
      WHERE ad_group_asset.field_type IN ${LINK_FIELD_TYPES} AND ad_group_asset.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'`,
  ];
  const cfgLabels = ["ad URLs", "Performance Max URLs", "account-level asset URLs", "campaign-level asset URLs", "ad group-level asset URLs"];

  const cfg = await Promise.allSettled(cfgQueries.map((q) => search(q)));
  const failures = [];
  cfg.forEach((s, i) => { if (s.status === "rejected") failures.push(cfgLabels[i]); });

  const srcLabel = (ft) => (ft === "PROMOTION" ? "Promotion" : "Sitelink");

  // 0: ads
  if (cfg[0].status === "fulfilled") (cfg[0].value.results || []).forEach((r) => {
    const cid = String(r.campaign?.id || ""), cname = r.campaign?.name || "";
    const agId = String(r.adGroup?.id || ""), agName = r.adGroup?.name || "";
    const entity = "ad:" + String(r.adGroupAd?.ad?.id || "");
    (r.adGroupAd?.ad?.finalUrls || []).forEach((u) => { if (u) addUrl("Ad|" + cid + ":" + agId + "|" + u, { name: cname, adGroup: agName, source: "Ad", finalUrl: u }, entity); });
  });
  // 1: performance max
  if (cfg[1].status === "fulfilled") (cfg[1].value.results || []).forEach((r) => {
    const cid = String(r.campaign?.id || ""), cname = r.campaign?.name || "";
    const agId = String(r.assetGroup?.id || ""), agName = r.assetGroup?.name || "";
    const entity = "ag:" + agId;
    (r.assetGroup?.finalUrls || []).forEach((u) => { if (u) addUrl("AssetGroup|" + cid + ":" + agId + "|" + u, { name: cname, adGroup: agName, source: "Asset Group", finalUrl: u }, entity); });
  });
  // 2: account-level sitelink / promotion
  if (cfg[2].status === "fulfilled") (cfg[2].value.results || []).forEach((r) => {
    const aid = assetId(r.customerAsset?.asset), src = srcLabel(r.customerAsset?.fieldType), entity = "ca:" + aid;
    (r.asset?.finalUrls || []).forEach((u) => { if (u) addUrl(src + "|ALL|" + u, { name: "All Campaigns", adGroup: "", source: src, finalUrl: u }, entity); });
  });
  // 3: campaign-level sitelink / promotion
  if (cfg[3].status === "fulfilled") (cfg[3].value.results || []).forEach((r) => {
    const cid = String(r.campaign?.id || ""), cname = r.campaign?.name || "";
    const aid = assetId(r.campaignAsset?.asset), src = srcLabel(r.campaignAsset?.fieldType), entity = "pa:" + cid + ":" + aid;
    (r.asset?.finalUrls || []).forEach((u) => { if (u) addUrl(src + "|" + cid + ":|" + u, { name: cname, adGroup: "", source: src, finalUrl: u }, entity); });
  });
  // 4: ad-group-level sitelink / promotion
  if (cfg[4].status === "fulfilled") (cfg[4].value.results || []).forEach((r) => {
    const cid = String(r.campaign?.id || ""), cname = r.campaign?.name || "";
    const agId = String(r.adGroup?.id || ""), agName = r.adGroup?.name || "";
    const aid = assetId(r.adGroupAsset?.asset), src = srcLabel(r.adGroupAsset?.fieldType), entity = "ga:" + agId + ":" + aid;
    (r.asset?.finalUrls || []).forEach((u) => { if (u) addUrl(src + "|" + cid + ":" + agId + "|" + u, { name: cname, adGroup: agName, source: src, finalUrl: u }, entity); });
  });

  if (failures.length === cfgQueries.length) return json({ error: "Could not load landing pages" }, 500);

  // ---------- price assets (best-effort, fully isolated) ----------
  // URLs come from the `asset` resource (price_offerings can't ride along with campaign/ad_group fields);
  // links come from the link resources without price_offerings; the two are joined by asset id.
  const priceQueries = [
    `SELECT asset.id, asset.price_asset.price_offerings FROM asset WHERE asset.type = 'PRICE'`,
    `SELECT customer_asset.asset FROM customer_asset WHERE customer_asset.field_type = 'PRICE' AND customer_asset.status = 'ENABLED'`,
    `SELECT campaign.id, campaign.name, campaign_asset.asset FROM campaign_asset WHERE campaign_asset.field_type = 'PRICE' AND campaign_asset.status = 'ENABLED' AND campaign.status = 'ENABLED'`,
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_asset.asset FROM ad_group_asset WHERE ad_group_asset.field_type = 'PRICE' AND ad_group_asset.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'`,
  ];
  const price = await Promise.allSettled(priceQueries.map((q) => search(q)));
  let priceFailed = price.some((s) => s.status === "rejected");

  // asset id -> [offering final URLs]
  const priceUrls = new Map();
  if (price[0].status === "fulfilled") (price[0].value.results || []).forEach((r) => {
    const id = String(r.asset?.id || "");
    const urls = (r.asset?.priceAsset?.priceOfferings || []).map((o) => o?.finalUrl).filter(Boolean);
    if (id && urls.length) priceUrls.set(id, urls);
  });
  const addPriceRows = (aid, rowBase, entity) => (priceUrls.get(aid) || []).forEach((u) => addUrl(rowBase.keyScope + "|" + u, { name: rowBase.name, adGroup: rowBase.adGroup, source: "Price", finalUrl: u }, entity));
  // account-level price
  if (price[1].status === "fulfilled") (price[1].value.results || []).forEach((r) => {
    const aid = assetId(r.customerAsset?.asset);
    addPriceRows(aid, { keyScope: "Price|ALL", name: "All Campaigns", adGroup: "" }, "ca:" + aid);
  });
  // campaign-level price
  if (price[2].status === "fulfilled") (price[2].value.results || []).forEach((r) => {
    const cid = String(r.campaign?.id || ""), aid = assetId(r.campaignAsset?.asset);
    addPriceRows(aid, { keyScope: "Price|" + cid + ":", name: r.campaign?.name || "", adGroup: "" }, "pa:" + cid + ":" + aid);
  });
  // ad-group-level price
  if (price[3].status === "fulfilled") (price[3].value.results || []).forEach((r) => {
    const cid = String(r.campaign?.id || ""), agId = String(r.adGroup?.id || ""), aid = assetId(r.adGroupAsset?.asset);
    addPriceRows(aid, { keyScope: "Price|" + cid + ":" + agId, name: r.campaign?.name || "", adGroup: r.adGroup?.name || "" }, "ga:" + agId + ":" + aid);
  });

  // ---------- metrics overlay (last 30 days, parallel, best-effort) ----------
  const metQueries = [
    `SELECT ad_group_ad.ad.id, metrics.clicks, metrics.impressions, metrics.conversions FROM ad_group_ad WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
    `SELECT asset_group.id, metrics.clicks, metrics.impressions, metrics.conversions FROM asset_group WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
    `SELECT customer_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions FROM customer_asset WHERE customer_asset.field_type IN ${METRIC_FIELD_TYPES} AND segments.date DURING LAST_30_DAYS`,
    `SELECT campaign.id, campaign_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign_asset WHERE campaign_asset.field_type IN ${METRIC_FIELD_TYPES} AND campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
    `SELECT ad_group.id, ad_group_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions FROM ad_group_asset WHERE ad_group_asset.field_type IN ${METRIC_FIELD_TYPES} AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
  ];
  const met = await Promise.allSettled(metQueries.map((q) => search(q)));
  if (met[0].status === "fulfilled") (met[0].value.results || []).forEach((r) => applyMetrics("ad:" + String(r.adGroupAd?.ad?.id || ""), r.metrics));
  if (met[1].status === "fulfilled") (met[1].value.results || []).forEach((r) => applyMetrics("ag:" + String(r.assetGroup?.id || ""), r.metrics));
  if (met[2].status === "fulfilled") (met[2].value.results || []).forEach((r) => applyMetrics("ca:" + assetId(r.customerAsset?.asset), r.metrics));
  if (met[3].status === "fulfilled") (met[3].value.results || []).forEach((r) => applyMetrics("pa:" + String(r.campaign?.id || "") + ":" + assetId(r.campaignAsset?.asset), r.metrics));
  if (met[4].status === "fulfilled") (met[4].value.results || []).forEach((r) => applyMetrics("ga:" + String(r.adGroup?.id || "") + ":" + assetId(r.adGroupAsset?.asset), r.metrics));

  const rows = [...byUrl.values()].map((r) => ({
    name: r.name,
    adGroup: r.adGroup,
    source: r.source,
    finalUrl: r.finalUrl,
    clicks: r.clicks,
    ctr: r.impressions ? r.clicks / r.impressions : 0,
    convRate: r.clicks ? r.conversions / r.clicks : 0,
  }));

  if (priceFailed) failures.push("price asset URLs");
  const warning = failures.length ? "Some URLs couldn't be read: " + failures.join(", ") : undefined;
  return json({ rows, warning });
}

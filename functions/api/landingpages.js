// GET /api/landingpages?customerId=1234567890[&debug=1]
// Lists final URLs on live placements, independent of recent serving:
//   • Ads (Search, Display, Shopping, Video, App, Demand Gen): enabled ad / ad group / campaign  → "Ad"
//   • Performance Max: enabled asset group in enabled campaign                                   → "Asset Group"
//   • Sitelink / Promotion / Price assets at account / campaign / ad-group level (enabled link)  → "Sitelink" / "Promotion" / "Price"
//
// Asset URLs are read from the `asset` resource directly (selecting asset.final_urls /
// price offerings *through* a link resource returns nothing in v24), then joined to the
// enabled links (customer_asset / campaign_asset / ad_group_asset) by asset id.
// Account-level assets show once as "All Campaigns".
//
// Clicks / CTR / conversion rate are a best-effort overlay for the last 30 days (0 when not served lately).
//   { rows: [{ name, adGroup, source, finalUrl, clicks, ctr, convRate }], warning?, diag? }

import {
  getRefreshToken,
  getAccessToken,
  adsRequest,
  json,
} from "../../shared/google.js";

const ASSET_FIELD_TYPES = "('SITELINK','PROMOTION','PRICE')";

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  const debug = url.searchParams.get("debug") === "1";
  if (!customerId) return json({ error: "Missing customerId" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  const accessToken = await getAccessToken(env, refreshToken);
  const search = (query) =>
    adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, { query });
  const assetId = (rn) => String(rn || "").split("/").pop();
  const srcLabel = (ft) => ({ SITELINK: "Sitelink", PROMOTION: "Promotion", PRICE: "Price" }[ft] || "Sitelink");

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
    const clicks = Number(m?.clicks) || 0, impressions = Number(m?.impressions) || 0, conversions = Number(m?.conversions) || 0;
    keys.forEach((key) => {
      const row = byUrl.get(key);
      if (!row) return;
      row.clicks += clicks; row.impressions += impressions; row.conversions += conversions;
    });
  };

  // ---------- all config queries (one round-trip, parallel, best-effort) ----------
  const Q = [
    // 0 ads
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.final_urls
       FROM ad_group_ad WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED'`,
    // 1 performance max
    `SELECT campaign.id, campaign.name, asset_group.id, asset_group.name, asset_group.final_urls
       FROM asset_group WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
    // 2 asset URLs for sitelink/promotion (read from the asset resource directly)
    `SELECT asset.id, asset.final_urls FROM asset WHERE asset.type IN ('SITELINK','PROMOTION')`,
    // 3 asset URLs for price (offerings carry their own final_url)
    `SELECT asset.id, asset.price_asset.price_offerings FROM asset WHERE asset.type = 'PRICE'`,
    // 4 account-level links
    `SELECT customer_asset.asset, customer_asset.field_type
       FROM customer_asset WHERE customer_asset.field_type IN ${ASSET_FIELD_TYPES} AND customer_asset.status = 'ENABLED'`,
    // 5 campaign-level links
    `SELECT campaign.id, campaign.name, campaign_asset.asset, campaign_asset.field_type
       FROM campaign_asset WHERE campaign_asset.field_type IN ${ASSET_FIELD_TYPES} AND campaign_asset.status = 'ENABLED' AND campaign.status = 'ENABLED'`,
    // 6 ad-group-level links
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_asset.asset, ad_group_asset.field_type
       FROM ad_group_asset WHERE ad_group_asset.field_type IN ${ASSET_FIELD_TYPES} AND ad_group_asset.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'`,
  ];
  const LABELS = ["ad URLs", "Performance Max URLs", "sitelink/promotion asset URLs", "price asset URLs", "account-level links", "campaign-level links", "ad group-level links"];
  const settled = await Promise.allSettled(Q.map((q) => search(q)));
  const ok = (i) => settled[i].status === "fulfilled";
  const rowsOf = (i) => (ok(i) ? (settled[i].value.results || []) : []);
  const failures = [];
  settled.forEach((s, i) => { if (s.status === "rejected") failures.push(LABELS[i]); });

  // asset id -> [final URLs]  (built from the direct asset queries)
  const assetUrls = new Map();
  const addAssetUrls = (id, urls) => {
    if (!id || !urls || !urls.length) return;
    const cur = assetUrls.get(id) || [];
    urls.forEach((u) => { if (u && !cur.includes(u)) cur.push(u); });
    assetUrls.set(id, cur);
  };
  rowsOf(2).forEach((r) => addAssetUrls(String(r.asset?.id || ""), r.asset?.finalUrls || []));
  rowsOf(3).forEach((r) => addAssetUrls(String(r.asset?.id || ""), (r.asset?.priceAsset?.priceOfferings || []).map((o) => o?.finalUrl).filter(Boolean)));

  // 0 ads
  rowsOf(0).forEach((r) => {
    const cid = String(r.campaign?.id || ""), cname = r.campaign?.name || "", agId = String(r.adGroup?.id || ""), agName = r.adGroup?.name || "";
    const entity = "ad:" + String(r.adGroupAd?.ad?.id || "");
    (r.adGroupAd?.ad?.finalUrls || []).forEach((u) => { if (u) addUrl("Ad|" + cid + ":" + agId + "|" + u, { name: cname, adGroup: agName, source: "Ad", finalUrl: u }, entity); });
  });
  // 1 performance max
  rowsOf(1).forEach((r) => {
    const cid = String(r.campaign?.id || ""), cname = r.campaign?.name || "", agId = String(r.assetGroup?.id || ""), agName = r.assetGroup?.name || "";
    (r.assetGroup?.finalUrls || []).forEach((u) => { if (u) addUrl("AssetGroup|" + cid + ":" + agId + "|" + u, { name: cname, adGroup: agName, source: "Asset Group", finalUrl: u }, "ag:" + agId); });
  });
  // 4 account-level links
  rowsOf(4).forEach((r) => {
    const aid = assetId(r.customerAsset?.asset), src = srcLabel(r.customerAsset?.fieldType);
    (assetUrls.get(aid) || []).forEach((u) => addUrl(src + "|ALL|" + u, { name: "All Campaigns", adGroup: "", source: src, finalUrl: u }, "ca:" + aid));
  });
  // 5 campaign-level links
  rowsOf(5).forEach((r) => {
    const cid = String(r.campaign?.id || ""), cname = r.campaign?.name || "", aid = assetId(r.campaignAsset?.asset), src = srcLabel(r.campaignAsset?.fieldType);
    (assetUrls.get(aid) || []).forEach((u) => addUrl(src + "|" + cid + ":|" + u, { name: cname, adGroup: "", source: src, finalUrl: u }, "pa:" + cid + ":" + aid));
  });
  // 6 ad-group-level links
  rowsOf(6).forEach((r) => {
    const cid = String(r.campaign?.id || ""), cname = r.campaign?.name || "", agId = String(r.adGroup?.id || ""), agName = r.adGroup?.name || "", aid = assetId(r.adGroupAsset?.asset), src = srcLabel(r.adGroupAsset?.fieldType);
    (assetUrls.get(aid) || []).forEach((u) => addUrl(src + "|" + cid + ":" + agId + "|" + u, { name: cname, adGroup: agName, source: src, finalUrl: u }, "ga:" + agId + ":" + aid));
  });

  if (failures.length === Q.length) return json({ error: "Could not load landing pages" }, 500);

  // ---------- metrics overlay (last 30 days, parallel, best-effort) ----------
  const M = [
    `SELECT ad_group_ad.ad.id, metrics.clicks, metrics.impressions, metrics.conversions FROM ad_group_ad WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
    `SELECT asset_group.id, metrics.clicks, metrics.impressions, metrics.conversions FROM asset_group WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
    `SELECT customer_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions FROM customer_asset WHERE customer_asset.field_type IN ${ASSET_FIELD_TYPES} AND segments.date DURING LAST_30_DAYS`,
    `SELECT campaign.id, campaign_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign_asset WHERE campaign_asset.field_type IN ${ASSET_FIELD_TYPES} AND campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
    `SELECT ad_group.id, ad_group_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions FROM ad_group_asset WHERE ad_group_asset.field_type IN ${ASSET_FIELD_TYPES} AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
  ];
  const met = await Promise.allSettled(M.map((q) => search(q)));
  const mRows = (i) => (met[i].status === "fulfilled" ? (met[i].value.results || []) : []);
  mRows(0).forEach((r) => applyMetrics("ad:" + String(r.adGroupAd?.ad?.id || ""), r.metrics));
  mRows(1).forEach((r) => applyMetrics("ag:" + String(r.assetGroup?.id || ""), r.metrics));
  mRows(2).forEach((r) => applyMetrics("ca:" + assetId(r.customerAsset?.asset), r.metrics));
  mRows(3).forEach((r) => applyMetrics("pa:" + String(r.campaign?.id || "") + ":" + assetId(r.campaignAsset?.asset), r.metrics));
  mRows(4).forEach((r) => applyMetrics("ga:" + String(r.adGroup?.id || "") + ":" + assetId(r.adGroupAsset?.asset), r.metrics));

  const rows = [...byUrl.values()].map((r) => ({
    name: r.name, adGroup: r.adGroup, source: r.source, finalUrl: r.finalUrl,
    clicks: r.clicks,
    ctr: r.impressions ? r.clicks / r.impressions : 0,
    convRate: r.clicks ? r.conversions / r.clicks : 0,
  }));

  const warning = failures.length ? "Some URLs couldn't be read: " + failures.join(", ") : undefined;

  if (debug) {
    const sourceCounts = {};
    rows.forEach((r) => { sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1; });
    const diag = {
      queries: settled.map((s, i) => ({
        label: LABELS[i],
        status: s.status,
        count: s.status === "fulfilled" ? (s.value.results || []).length : 0,
        error: s.status === "rejected" ? String(s.reason && s.reason.message ? s.reason.message : s.reason).slice(0, 400) : undefined,
      })),
      assetUrlMapSize: assetUrls.size,
      sampleAssetIds: [...assetUrls.keys()].slice(0, 5),
      sourceCounts,
      totalRows: rows.length,
    };
    return json({ rows, warning, diag });
  }

  return json({ rows, warning });
}

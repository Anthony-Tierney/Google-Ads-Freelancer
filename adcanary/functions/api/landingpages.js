// GET /api/landingpages?customerId=1234567890[&debug=1]
// Lists final URLs on live placements, independent of recent serving:
//   • Ads (Search/Display/Shopping/Video/App/Demand Gen): enabled ad/ad group/campaign  → "Ad"
//   • Performance Max: enabled asset group in enabled campaign                            → "Asset Group"
//   • Sitelink / Promotion / Price assets at account/campaign/ad-group level             → "Sitelink"/"Promotion"/"Price"
//
// Asset URLs are read from the `asset` resource directly. Link resources
// (customer_asset/campaign_asset/ad_group_asset) reject selecting attributed campaign.*/
// ad_group.* fields, so the link queries read ONLY their own fields and campaign/ad-group
// names are resolved from separate lookups, joined by id.
//
// Clicks/CTR/conversion rate are a best-effort 30-day overlay (0 when not served lately).
//   { rows: [{ name, adGroup, source, finalUrl, clicks, ctr, convRate }], warning?, diag? }

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

const VERSION = "v4-decoupled-links";
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

  // Date range for the metrics overlay. Accepts a GAQL macro (e.g. LAST_30_DAYS) or a
  // "segments.date >= '...' AND segments.date <= '...'" clause; anything else falls back to 30 days.
  const drParam = url.searchParams.get("dateRange") || "LAST_30_DAYS";
  const drSafe = /^[A-Z0-9_]+$/.test(drParam) || /^segments\.date >= '\d{8}' AND segments\.date <= '\d{8}'$/.test(drParam);
  const dateClause = drSafe ? (/segments\.date/i.test(drParam) ? drParam : "segments.date DURING " + drParam) : "segments.date DURING LAST_30_DAYS";

  const accessToken = await getAccessToken(env, refreshToken);
  const search = (query) => adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, { query });
  const idOf = (rn) => String(rn || "").split("/").pop();
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
    keys.forEach((key) => { const row = byUrl.get(key); if (row) { row.clicks += clicks; row.impressions += impressions; row.conversions += conversions; } });
  };

  // ---------- config queries (parallel, best-effort) ----------
  const Q = [
    // 0 ads
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.final_urls
       FROM ad_group_ad WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED'`,
    // 1 performance max
    `SELECT campaign.id, campaign.name, asset_group.id, asset_group.name, asset_group.final_urls
       FROM asset_group WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
    // 2 sitelink/promotion asset URLs (from the asset resource directly)
    `SELECT asset.id, asset.final_urls FROM asset WHERE asset.type IN ('SITELINK','PROMOTION')`,
    // 3 price asset URLs
    `SELECT asset.id, asset.price_asset.price_offerings FROM asset WHERE asset.type = 'PRICE'`,
    // 4 enabled campaigns (id -> name)
    `SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status = 'ENABLED'`,
    // 5 enabled ad groups (id -> name + parent campaign)
    `SELECT ad_group.id, ad_group.name, campaign.id, campaign.name FROM ad_group WHERE ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'`,
    // 6 account-level links (link-own fields only)
    `SELECT customer_asset.resource_name, customer_asset.asset, customer_asset.field_type
       FROM customer_asset WHERE customer_asset.field_type IN ${ASSET_FIELD_TYPES} AND customer_asset.status = 'ENABLED'`,
    // 7 campaign-level links (link-own fields only)
    `SELECT campaign_asset.resource_name, campaign_asset.campaign, campaign_asset.asset, campaign_asset.field_type
       FROM campaign_asset WHERE campaign_asset.field_type IN ${ASSET_FIELD_TYPES} AND campaign_asset.status = 'ENABLED'`,
    // 8 ad-group-level links (link-own fields only)
    `SELECT ad_group_asset.resource_name, ad_group_asset.ad_group, ad_group_asset.asset, ad_group_asset.field_type
       FROM ad_group_asset WHERE ad_group_asset.field_type IN ${ASSET_FIELD_TYPES} AND ad_group_asset.status = 'ENABLED'`,
  ];
  const LABELS = ["ad URLs", "Performance Max URLs", "sitelink/promotion asset URLs", "price asset URLs", "enabled campaigns", "enabled ad groups", "account-level links", "campaign-level links", "ad group-level links"];
  const settled = await Promise.allSettled(Q.map((q) => search(q)));
  const rowsOf = (i) => (settled[i].status === "fulfilled" ? (settled[i].value.results || []) : []);
  const failures = [];
  settled.forEach((s, i) => { if (s.status === "rejected") failures.push(LABELS[i]); });

  // asset id -> [final URLs]
  const assetUrls = new Map();
  const addAssetUrls = (id, urls) => {
    if (!id || !urls?.length) return;
    const cur = assetUrls.get(id) || [];
    urls.forEach((u) => { if (u && !cur.includes(u)) cur.push(u); });
    assetUrls.set(id, cur);
  };
  rowsOf(2).forEach((r) => addAssetUrls(String(r.asset?.id || ""), r.asset?.finalUrls || []));
  rowsOf(3).forEach((r) => addAssetUrls(String(r.asset?.id || ""), (r.asset?.priceAsset?.priceOfferings || []).map((o) => o?.finalUrl).filter(Boolean)));

  // id -> name lookups
  const campName = new Map();
  rowsOf(4).forEach((r) => campName.set(String(r.campaign?.id || ""), r.campaign?.name || ""));
  const agInfo = new Map(); // agId -> { name, campId, campName }
  rowsOf(5).forEach((r) => agInfo.set(String(r.adGroup?.id || ""), { name: r.adGroup?.name || "", campId: String(r.campaign?.id || ""), campName: r.campaign?.name || "" }));

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
  // 6 account-level links
  rowsOf(6).forEach((r) => {
    const aid = idOf(r.customerAsset?.asset), src = srcLabel(r.customerAsset?.fieldType);
    (assetUrls.get(aid) || []).forEach((u) => addUrl(src + "|ALL|" + u, { name: "All Campaigns", adGroup: "", source: src, finalUrl: u }, "ca:" + aid));
  });
  // 7 campaign-level links (only enabled campaigns)
  rowsOf(7).forEach((r) => {
    const cid = idOf(r.campaignAsset?.campaign);
    if (!campName.has(cid)) return;
    const aid = idOf(r.campaignAsset?.asset), src = srcLabel(r.campaignAsset?.fieldType);
    (assetUrls.get(aid) || []).forEach((u) => addUrl(src + "|" + cid + ":|" + u, { name: campName.get(cid), adGroup: "", source: src, finalUrl: u }, "pa:" + cid + ":" + aid));
  });
  // 8 ad-group-level links (only enabled ad groups in enabled campaigns)
  rowsOf(8).forEach((r) => {
    const agId = idOf(r.adGroupAsset?.ad_group || r.adGroupAsset?.adGroup);
    const ag = agInfo.get(agId);
    if (!ag) return;
    const aid = idOf(r.adGroupAsset?.asset), src = srcLabel(r.adGroupAsset?.fieldType);
    (assetUrls.get(aid) || []).forEach((u) => addUrl(src + "|" + ag.campId + ":" + agId + "|" + u, { name: ag.campName, adGroup: ag.name, source: src, finalUrl: u }, "ga:" + agId + ":" + aid));
  });

  if (failures.length === Q.length) return json({ error: "Could not load landing pages", version: VERSION }, 500);

  // ---------- metrics overlay (last 30 days, parallel, best-effort) ----------
  const M = [
    `SELECT ad_group_ad.ad.id, metrics.clicks, metrics.impressions, metrics.conversions FROM ad_group_ad WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED' AND ${dateClause}`,
    `SELECT asset_group.id, metrics.clicks, metrics.impressions, metrics.conversions FROM asset_group WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED' AND ${dateClause}`,
    `SELECT customer_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions FROM customer_asset WHERE customer_asset.field_type IN ${ASSET_FIELD_TYPES} AND ${dateClause}`,
    `SELECT campaign_asset.campaign, campaign_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign_asset WHERE campaign_asset.field_type IN ${ASSET_FIELD_TYPES} AND ${dateClause}`,
    `SELECT ad_group_asset.ad_group, ad_group_asset.asset, metrics.clicks, metrics.impressions, metrics.conversions FROM ad_group_asset WHERE ad_group_asset.field_type IN ${ASSET_FIELD_TYPES} AND ${dateClause}`,
  ];
  const met = await Promise.allSettled(M.map((q) => search(q)));
  const mRows = (i) => (met[i].status === "fulfilled" ? (met[i].value.results || []) : []);
  mRows(0).forEach((r) => applyMetrics("ad:" + String(r.adGroupAd?.ad?.id || ""), r.metrics));
  mRows(1).forEach((r) => applyMetrics("ag:" + String(r.assetGroup?.id || ""), r.metrics));
  mRows(2).forEach((r) => applyMetrics("ca:" + idOf(r.customerAsset?.asset), r.metrics));
  mRows(3).forEach((r) => applyMetrics("pa:" + idOf(r.campaignAsset?.campaign) + ":" + idOf(r.campaignAsset?.asset), r.metrics));
  mRows(4).forEach((r) => applyMetrics("ga:" + idOf(r.adGroupAsset?.ad_group || r.adGroupAsset?.adGroup) + ":" + idOf(r.adGroupAsset?.asset), r.metrics));

  const rows = [...byUrl.values()].map((r) => ({
    name: r.name, adGroup: r.adGroup, source: r.source, finalUrl: r.finalUrl,
    clicks: r.clicks,
    conversions: r.conversions,
  }));

  const warning = failures.length ? "Some URLs couldn't be read: " + failures.join(", ") : undefined;

  if (debug) {
    const sourceCounts = {};
    rows.forEach((r) => { sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1; });
    const diag = {
      version: VERSION,
      queries: settled.map((s, i) => ({
        label: LABELS[i],
        status: s.status,
        count: s.status === "fulfilled" ? (s.value.results || []).length : 0,
        error: s.status === "rejected" ? String(s.reason?.message ? s.reason.message : s.reason).slice(0, 300) : undefined,
      })),
      assetUrlMapSize: assetUrls.size,
      enabledCampaigns: campName.size,
      enabledAdGroups: agInfo.size,
      sourceCounts,
      totalRows: rows.length,
    };
    return json({ rows, warning, diag });
  }

  return json({ rows, warning });
}

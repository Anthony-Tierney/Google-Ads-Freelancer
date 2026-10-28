// GET /api/callouts?customerId=<id>&dateRange=<gaql date clause>[&debug=1]
// Callout assets linked to the account, a campaign or an ad group (callouts aren't part of
// individual ads). Only ENABLED links in non-removed campaigns / ad groups are included.
// Metrics are fetched per link in separate queries (same pattern as the Landing Pages endpoint).
//   { rows: [{ text, linkLevel: "Account"|"Campaign"|"Ad group", campaignId, name, campaignStatus,
//              adGroupId, adGroup, adGroupStatus, impressions, clicks }], warning?, diag? }

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

const STATUS_LABEL = { ENABLED: "Enabled", PAUSED: "Paused" };

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  const debug = url.searchParams.get("debug") === "1";
  if (!customerId || customerId === "ALL") return json({ error: "Missing customerId" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  const drParam = url.searchParams.get("dateRange") || "LAST_30_DAYS";
  const drFixed = drParam.replace(/'(\d{4})(\d{2})(\d{2})'/g, "'$1-$2-$3'");
  const dateClause = /segments\.date/i.test(drFixed) ? drFixed : "segments.date DURING " + drFixed;

  const accessToken = await getAccessToken(env, refreshToken);
  const search = (query) => adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, { query });

  const errors = [];
  const diag = {};
  const tryQ = async (label, q) => {
    try { const r = await search(q); diag[label] = (r.results || []).length; return r.results || []; }
    catch (e) { diag[label] = "error"; errors.push(label + ": " + String(e?.message || e).slice(0, 200)); return null; }
  };

  const [ended, texts, lAcct, lCamp, lAg, mAcct, mCamp, mAg] = await Promise.all([
    endedCampaignIds(search),
    tryQ("text", `SELECT asset.resource_name, asset.callout_asset.callout_text FROM asset WHERE asset.type = 'CALLOUT'`),
    tryQ("account links", `SELECT customer_asset.asset FROM customer_asset WHERE customer_asset.field_type = 'CALLOUT' AND customer_asset.status = 'ENABLED'`),
    tryQ("campaign links", `SELECT campaign.id, campaign.name, campaign.status, campaign_asset.asset FROM campaign_asset WHERE campaign_asset.field_type = 'CALLOUT' AND campaign_asset.status = 'ENABLED' AND campaign.status != 'REMOVED'`),
    tryQ("ad group links", `SELECT campaign.id, campaign.name, campaign.status, ad_group.id, ad_group.name, ad_group.status, ad_group_asset.asset FROM ad_group_asset WHERE ad_group_asset.field_type = 'CALLOUT' AND ad_group_asset.status = 'ENABLED' AND campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED'`),
    tryQ("account metrics", `SELECT customer_asset.asset, metrics.impressions, metrics.clicks FROM customer_asset WHERE customer_asset.field_type = 'CALLOUT' AND ${dateClause}`),
    tryQ("campaign metrics", `SELECT campaign.id, campaign_asset.asset, metrics.impressions, metrics.clicks FROM campaign_asset WHERE campaign_asset.field_type = 'CALLOUT' AND ${dateClause}`),
    tryQ("ad group metrics", `SELECT ad_group.id, ad_group_asset.asset, metrics.impressions, metrics.clicks FROM ad_group_asset WHERE ad_group_asset.field_type = 'CALLOUT' AND ${dateClause}`),
  ]);

  if (!texts) return json({ error: "Could not load callouts: " + errors.join(" · ") }, 500);

  const textOf = new Map();
  texts.forEach((r) => { const t = r.asset?.calloutAsset?.calloutText; if (t) textOf.set(r.asset.resourceName, t); });

  const metricsOf = new Map();
  const addM = (key, r) => {
    const m = metricsOf.get(key) || { impressions: 0, clicks: 0 };
    m.impressions += Number(r.metrics?.impressions) || 0;
    m.clicks += Number(r.metrics?.clicks) || 0;
    metricsOf.set(key, m);
  };
  (mAcct || []).forEach((r) => addM("acct|" + r.customerAsset?.asset, r));
  (mCamp || []).forEach((r) => addM("camp|" + r.campaign?.id + "|" + r.campaignAsset?.asset, r));
  (mAg || []).forEach((r) => addM("ag|" + r.adGroup?.id + "|" + r.adGroupAsset?.asset, r));

  const rows = [];
  const push = (key, asset, base) => {
    const text = textOf.get(asset);
    if (!text) return;
    const m = metricsOf.get(key) || { impressions: 0, clicks: 0 };
    rows.push({ text, ...base, impressions: m.impressions, clicks: m.clicks });
  };
  const campLabel = (c) => (c?.status === "ENABLED" && ended.has(String(c?.id)) ? "Ended" : (STATUS_LABEL[c?.status] || ""));
  (lAcct || []).forEach((r) => push("acct|" + r.customerAsset?.asset, r.customerAsset?.asset,
    { linkLevel: "Account", campaignId: "", name: "All campaigns", campaignStatus: "Enabled", adGroupId: "", adGroup: "All ad groups", adGroupStatus: "Enabled" }));
  (lCamp || []).forEach((r) => push("camp|" + r.campaign?.id + "|" + r.campaignAsset?.asset, r.campaignAsset?.asset,
    { linkLevel: "Campaign", campaignId: String(r.campaign?.id || ""), name: r.campaign?.name || "", campaignStatus: campLabel(r.campaign), adGroupId: "", adGroup: "All ad groups", adGroupStatus: "Enabled" }));
  (lAg || []).forEach((r) => push("ag|" + r.adGroup?.id + "|" + r.adGroupAsset?.asset, r.adGroupAsset?.asset,
    { linkLevel: "Ad group", campaignId: String(r.campaign?.id || ""), name: r.campaign?.name || "", campaignStatus: campLabel(r.campaign), adGroupId: String(r.adGroup?.id || ""), adGroup: r.adGroup?.name || "", adGroupStatus: STATUS_LABEL[r.adGroup?.status] || "" }));

  const payload = { rows };
  if (errors.length) payload.warning = "Some callout data couldn't be loaded: " + errors.slice(0, 2).join(" · ");
  if (debug) payload.diag = diag;
  return json(payload);
}

// Ended = an ENABLED campaign past its end date. The API only shows this via
// campaign.serving_status, so it's fetched separately and best-effort: if it fails,
// campaigns simply keep their normal status.
async function endedCampaignIds(search) {
  const ended = new Set();
  try {
    const r = await search(`SELECT campaign.id, campaign.serving_status FROM campaign WHERE campaign.status = 'ENABLED'`);
    (Array.isArray(r) ? r : (r.results || [])).forEach((x) => { if (x.campaign?.servingStatus === "ENDED") ended.add(String(x.campaign.id)); });
  } catch { /* leave empty */ }
  return ended;
}

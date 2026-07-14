// GET /api/adcopy?customerId=1234567890[&debug=1]
// Lists Headline and Description text assets from enabled Responsive Search Ads
// (enabled ad group + campaign), aggregated to Campaign + Ad Group + Asset Type + Text
// — metrics are summed across any ads within an ad group that happen to reuse the
// same asset text, since the table shows one row per unique piece of copy, not per ad.
//   { rows: [{ name, adGroup, assetType, text, impressions, clicks, ctr }], warning?, diag? }

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

const VERSION = "v1";
const FIELD_LABEL = { HEADLINE: "Headline", DESCRIPTION: "Description" };

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  const debug = url.searchParams.get("debug") === "1";
  if (!customerId) return json({ error: "Missing customerId" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  // Date range for the metrics window. Accepts a GAQL macro (e.g. LAST_30_DAYS) or a
  // "segments.date >= '...' AND segments.date <= '...'" clause; anything else falls back to 30 days.
  const drParam = url.searchParams.get("dateRange") || "LAST_30_DAYS";
  const drSafe = /^[A-Z0-9_]+$/.test(drParam) || /^segments\.date >= '\d{8}' AND segments\.date <= '\d{8}'$/.test(drParam);
  const dateClause = drSafe ? (/segments\.date/i.test(drParam) ? drParam : "segments.date DURING " + drParam) : "segments.date DURING LAST_30_DAYS";

  const accessToken = await getAccessToken(env, refreshToken);
  const search = (query) => adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, { query });

  const query = `
    SELECT
      campaign.id, campaign.name,
      ad_group.id, ad_group.name,
      ad_group_ad_asset_view.field_type,
      asset.id, asset.text_asset.text,
      metrics.clicks, metrics.impressions
    FROM ad_group_ad_asset_view
    WHERE ad_group_ad_asset_view.field_type IN ('HEADLINE','DESCRIPTION')
      AND campaign.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND ad_group_ad.status = 'ENABLED'
      AND ${dateClause}`;

  let results = [];
  let queryError = null;
  try {
    const res = await search(query);
    results = res.results || [];
  } catch (e) {
    queryError = String(e?.message || e).slice(0, 300);
  }

  if (queryError) return json({ error: "Could not load ad copy: " + queryError, version: VERSION }, 500);

  // Aggregate to Campaign + Ad Group + Asset Type + Text.
  const agg = new Map();
  results.forEach((r) => {
    const label = FIELD_LABEL[r.adGroupAdAssetView?.fieldType];
    if (!label) return;
    const text = r.asset?.textAsset?.text || "";
    const key = (r.campaign?.id || "") + "|" + (r.adGroup?.id || "") + "|" + label + "|" + text;
    let row = agg.get(key);
    if (!row) {
      row = { name: r.campaign?.name || "", adGroup: r.adGroup?.name || "", assetType: label, text, impressions: 0, clicks: 0 };
      agg.set(key, row);
    }
    row.impressions += Number(r.metrics?.impressions) || 0;
    row.clicks += Number(r.metrics?.clicks) || 0;
  });

  const rows = [...agg.values()].map((r) => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0 }));

  if (debug) {
    return json({ rows, diag: { version: VERSION, rawResultCount: results.length, aggregatedRowCount: rows.length } });
  }

  return json({ rows });
}

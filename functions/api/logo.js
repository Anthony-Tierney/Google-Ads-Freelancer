// GET /api/logo?customerId=1234567890
// Best-effort account logo. Google Ads has no account-level logo field, so we look for
// LOGO / LANDSCAPE_LOGO image assets linked at the account, Performance Max (asset group),
// or campaign level, and return the first usable image URL. Returns { logoUrl } (or null).

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

  const IMG = "asset.image_asset.full_size.url, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels";

  // Queried in priority order: account-level, then Performance Max, then campaign-level.
  const [custR, agR, campR] = await Promise.allSettled([
    search(`SELECT customer_asset.field_type, ${IMG} FROM customer_asset WHERE customer_asset.field_type IN ('LOGO','LANDSCAPE_LOGO') AND customer_asset.status != 'REMOVED'`),
    search(`SELECT asset_group_asset.field_type, ${IMG} FROM asset_group_asset WHERE asset_group_asset.field_type IN ('LOGO','LANDSCAPE_LOGO') AND asset_group_asset.status != 'REMOVED'`),
    search(`SELECT campaign_asset.field_type, ${IMG} FROM campaign_asset WHERE campaign_asset.field_type IN ('LOGO','LANDSCAPE_LOGO') AND campaign_asset.status != 'REMOVED'`),
  ]);

  let logo = null;        // square LOGO (preferred)
  let landscape = null;   // LANDSCAPE_LOGO (fallback)

  const consume = (settled, linkKey) => {
    if (settled.status !== "fulfilled") return;
    for (const row of (settled.value.results || [])) {
      const url = row.asset?.imageAsset?.fullSize?.url;
      if (!url) continue;
      const ft = row[linkKey]?.fieldType;
      if (ft === "LOGO" && !logo) logo = url;
      else if (ft === "LANDSCAPE_LOGO" && !landscape) landscape = url;
    }
  };

  consume(custR, "customerAsset");
  consume(agR, "assetGroupAsset");
  consume(campR, "campaignAsset");

  return json({ logoUrl: logo || landscape || null });
}

// GET /api/assets?customerId=1234567890
// Returns each (non-removed) campaign with counts of assets that are actually
// serving (enabled link + policy-approved / eligible) at the CAMPAIGN level:
//   { campaigns: [{ id, name, status, sitelinks, images, callouts, snippets }] }

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

  // 1) Campaigns (exclude removed)
  let campaigns = {};
  try {
    const campRes = await adsRequest(
      env,
      accessToken,
      `customers/${cleanId}/googleAds:search`,
      { query: "SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name" }
    );
    (campRes.results || []).forEach((r) => {
      const id = String(r.campaign?.id);
      campaigns[id] = {
        id,
        name: r.campaign?.name,
        status: r.campaign?.status,
        businessLogo: 0,
        businessName: 0,
        sitelinks: 0,
        landscape: 0,
        square: 0,
        callouts: 0,
        snippets: 0,
      };
    });
  } catch (e) {
    return json({ error: (e && e.message) ? e.message : "Could not load campaigns" }, 500);
  }

  // 2) Campaign-level assets. We filter on the enabled link status in the query
  //    (filterable), then determine "actually serving" from primary_status in code,
  //    because primary_status is selectable but not reliably filterable.
  let assetError = null;
  try {
    const assetRes = await adsRequest(
      env,
      accessToken,
      `customers/${cleanId}/googleAds:search`,
      {
        query: `
          SELECT
            campaign.id,
            campaign.status,
            campaign_asset.field_type,
            campaign_asset.status,
            campaign_asset.primary_status,
            asset.id,
            asset.image_asset.full_size.width_pixels,
            asset.image_asset.full_size.height_pixels
          FROM campaign_asset
          WHERE campaign_asset.status = 'ENABLED'
            AND campaign_asset.field_type IN ('SITELINK','AD_IMAGE','CALLOUT','STRUCTURED_SNIPPET')
            AND campaign.status != 'REMOVED'`,
      }
    );

    // ELIGIBLE = serving & approved; LIMITED = approved but serving with limits.
    // Anything else (NOT_ELIGIBLE/PENDING/PAUSED/REMOVED) is not actually serving.
    // If the API doesn't report a primary status, fall back to the enabled link.
    const SERVING = new Set(["ELIGIBLE", "LIMITED"]);
    (assetRes.results || []).forEach((r) => {
      const cid = String(r.campaign?.id);
      const c = campaigns[cid];
      if (!c) return;
      const ps = r.campaignAsset?.primaryStatus;
      const serving = ps ? SERVING.has(ps) : true;
      if (!serving) return;
      switch (r.campaignAsset?.fieldType) {
        case "SITELINK": c.sitelinks++; break;
        case "AD_IMAGE": {
          // Distinguish 1:1 square from 1.91:1 landscape by aspect ratio.
          // A ratio >= 1.3 is landscape; otherwise treat as square (1:1).
          const w = Number(r.asset?.imageAsset?.fullSize?.widthPixels) || 0;
          const h = Number(r.asset?.imageAsset?.fullSize?.heightPixels) || 0;
          if (w && h && (w / h) >= 1.3) c.landscape++;
          else c.square++;
          break;
        }
        case "CALLOUT": c.callouts++; break;
        case "STRUCTURED_SNIPPET": c.snippets++; break;
      }
    });
  } catch (e) {
    assetError = (e && e.message) ? e.message : "Could not load assets";
  }

  // 3) Business name + logo assets — at the campaign level and (for Performance Max /
  //    Demand Gen) the asset-group level. Counted per campaign, queried separately so a
  //    failure here doesn't wipe the asset counts above.
  try {
    const [campBiz, agBiz] = await Promise.allSettled([
      adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, {
        query: `SELECT campaign.id, campaign_asset.field_type, campaign_asset.status FROM campaign_asset WHERE campaign_asset.status = 'ENABLED' AND campaign_asset.field_type IN ('BUSINESS_NAME','BUSINESS_LOGO') AND campaign.status != 'REMOVED'`,
      }),
      adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, {
        query: `SELECT asset_group.campaign, asset_group_asset.field_type, asset_group_asset.status FROM asset_group_asset WHERE asset_group_asset.status = 'ENABLED' AND asset_group_asset.field_type IN ('BUSINESS_NAME','BUSINESS_LOGO')`,
      }),
    ]);

    const bump = (c, ft) => {
      if (ft === "BUSINESS_NAME") c.businessName++;
      else if (ft === "BUSINESS_LOGO") c.businessLogo++;
    };
    if (campBiz.status === "fulfilled") {
      (campBiz.value.results || []).forEach((r) => {
        const c = campaigns[String(r.campaign?.id)];
        if (c) bump(c, r.campaignAsset?.fieldType);
      });
    }
    if (agBiz.status === "fulfilled") {
      (agBiz.value.results || []).forEach((r) => {
        const cid = (r.assetGroup?.campaign || "").split("/").pop();
        const c = campaigns[cid];
        if (c) bump(c, r.assetGroupAsset?.fieldType);
      });
    }
    if (!assetError && campBiz.status !== "fulfilled" && agBiz.status !== "fulfilled") {
      assetError = (campBiz.reason && campBiz.reason.message) ? campBiz.reason.message : "Could not load business assets";
    }
  } catch (e) {
    if (!assetError) assetError = (e && e.message) ? e.message : "Could not load business assets";
  }

  return json({ campaigns: Object.values(campaigns), assetError });
}

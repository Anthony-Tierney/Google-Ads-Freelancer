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
        sitelinks: 0,
        images: 0,
        callouts: 0,
        snippets: 0,
      };
    });
  } catch (e) {
    return json({ error: (e && e.message) ? e.message : "Could not load campaigns" }, 500);
  }

  // 2) Campaign-level assets that are actually serving.
  //    primary_status = ELIGIBLE means enabled AND policy-approved AND eligible to serve.
  try {
    const assetRes = await adsRequest(
      env,
      accessToken,
      `customers/${cleanId}/googleAds:search`,
      {
        query: `
          SELECT
            campaign.id,
            campaign_asset.field_type,
            campaign_asset.status,
            campaign_asset.primary_status,
            asset.id
          FROM campaign_asset
          WHERE campaign_asset.status = 'ENABLED'
            AND campaign_asset.primary_status = 'ELIGIBLE'
            AND campaign_asset.field_type IN ('SITELINK','IMAGE','CALLOUT','STRUCTURED_SNIPPET')
            AND campaign.status != 'REMOVED'`,
      }
    );
    (assetRes.results || []).forEach((r) => {
      const cid = String(r.campaign?.id);
      const c = campaigns[cid];
      if (!c) return;
      switch (r.campaignAsset?.fieldType) {
        case "SITELINK": c.sitelinks++; break;
        case "IMAGE": c.images++; break;
        case "CALLOUT": c.callouts++; break;
        case "STRUCTURED_SNIPPET": c.snippets++; break;
      }
    });
  } catch (e) {
    return json({ campaigns: Object.values(campaigns), error: (e && e.message) ? e.message : "Could not load assets" });
  }

  return json({ campaigns: Object.values(campaigns) });
}

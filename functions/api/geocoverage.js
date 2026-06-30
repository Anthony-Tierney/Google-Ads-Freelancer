// GET /api/geocoverage?customerId=1234567890[&debug=1]
// Maps a campaign's location targeting using location_view (the report behind the
// Google Ads "Locations" screen), which returns both radius (PROXIMITY) and named
// (LOCATION) criteria with metrics.
//   • PROXIMITY → { campaign, lat, lng, radius, radiusUnits, clicks, impressions, conversions }  (bubbles)
//   • LOCATION  → { campaign, geoTargetId, name, clicks, impressions, conversions }              (named targets)
// Named-location names are resolved from the geo_target_constant resource (the API has no
// coordinates/boundaries for them, so geometry is handled client-side / later).

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

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
  const search = (query) => adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, { query });
  const idOf = (rn) => String(rn || "").split("/").pop();

  // location_view: one row per location criterion per campaign, metrics aggregated over the range.
  const LOCATION_VIEW_Q = `
    SELECT
      campaign.id, campaign.name,
      campaign_criterion.criterion_id, campaign_criterion.type,
      campaign_criterion.location.geo_target_constant,
      campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units,
      campaign_criterion.proximity.geo_point.latitude_in_micro_degrees,
      campaign_criterion.proximity.geo_point.longitude_in_micro_degrees,
      campaign_criterion.proximity.address.city_name,
      metrics.clicks, metrics.impressions, metrics.conversions
    FROM location_view
    WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`;

  let lvRows, lvError;
  try {
    lvRows = (await search(LOCATION_VIEW_Q)).results || [];
  } catch (e) {
    lvError = String(e && e.message ? e.message : e);
    return json(debug
      ? { radius: [], locations: [], warning: "location_view query failed", diag: { locationViewError: lvError.slice(0, 500), query: LOCATION_VIEW_Q.trim() } }
      : { error: "Could not load location targeting" }, debug ? 200 : 500);
  }

  const radius = [];
  const locations = [];
  const geoTargetIds = new Set();

  lvRows.forEach((r) => {
    const cc = r.campaignCriterion || {};
    const m = r.metrics || {};
    const base = {
      campaign: r.campaign?.name || "",
      campaignId: String(r.campaign?.id || ""),
      clicks: Number(m.clicks) || 0,
      impressions: Number(m.impressions) || 0,
      conversions: Number(m.conversions) || 0,
    };
    if (cc.type === "PROXIMITY" && cc.proximity) {
      const gp = cc.proximity.geoPoint || {};
      const lat = gp.latitudeInMicroDegrees != null ? gp.latitudeInMicroDegrees / 1e6 : null;
      const lng = gp.longitudeInMicroDegrees != null ? gp.longitudeInMicroDegrees / 1e6 : null;
      radius.push({
        ...base,
        lat, lng,
        radius: Number(cc.proximity.radius) || 0,
        radiusUnits: cc.proximity.radiusUnits || "KILOMETERS",
        city: cc.proximity.address?.cityName || "",
      });
    } else if (cc.type === "LOCATION" && cc.location?.geoTargetConstant) {
      const gid = idOf(cc.location.geoTargetConstant);
      geoTargetIds.add(cc.location.geoTargetConstant);
      locations.push({ ...base, geoTargetId: gid, geoTargetConstant: cc.location.geoTargetConstant, name: "" });
    }
  });

  // Resolve geo target constant names.
  let nameError;
  if (geoTargetIds.size) {
    const inList = [...geoTargetIds].map((rn) => `'${rn}'`).join(", ");
    try {
      const gtc = (await search(`SELECT geo_target_constant.resource_name, geo_target_constant.name, geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${inList})`)).results || [];
      const nameMap = new Map();
      gtc.forEach((g) => nameMap.set(g.geoTargetConstant?.resourceName, { name: g.geoTargetConstant?.name || "", canonical: g.geoTargetConstant?.canonicalName || "" }));
      locations.forEach((l) => {
        const n = nameMap.get(l.geoTargetConstant);
        if (n) l.name = n.canonical || n.name || ("Location " + l.geoTargetId);
        else l.name = "Location " + l.geoTargetId;
      });
    } catch (e) {
      nameError = String(e && e.message ? e.message : e);
      locations.forEach((l) => { if (!l.name) l.name = "Location " + l.geoTargetId; });
    }
  }

  const payload = { radius, locations };
  if (debug) {
    payload.diag = {
      locationViewRows: lvRows.length,
      proximityCount: radius.length,
      proximityWithGeoPoint: radius.filter((b) => b.lat != null && b.lng != null).length,
      locationCount: locations.length,
      nameError: nameError ? nameError.slice(0, 300) : undefined,
      sample: lvRows.slice(0, 3).map((r) => ({ type: r.campaignCriterion?.type, campaign: r.campaign?.name, clicks: r.metrics?.clicks })),
    };
  }
  return json(payload);
}

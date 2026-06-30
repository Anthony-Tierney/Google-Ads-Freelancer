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

  const drParam = url.searchParams.get("dateRange") || "LAST_30_DAYS";
  const drSafe = /^[A-Z0-9_]+$/.test(drParam) || /^segments\.date >= '\d{8}' AND segments\.date <= '\d{8}'$/.test(drParam);
  const dateClause = drSafe ? (/segments\.date/i.test(drParam) ? drParam : "segments.date DURING " + drParam) : "segments.date DURING LAST_30_DAYS";

  const accessToken = await getAccessToken(env, refreshToken);
  const search = (query) => adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, { query });
  const idOf = (rn) => String(rn || "").split("/").pop();

  // location_view: one row per location criterion per campaign, metrics aggregated over the range.
  const LOCATION_VIEW_Q = `
    SELECT
      campaign.id, campaign.name, campaign.status,
      campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative,
      campaign_criterion.location.geo_target_constant,
      campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units,
      campaign_criterion.proximity.geo_point.latitude_in_micro_degrees,
      campaign_criterion.proximity.geo_point.longitude_in_micro_degrees,
      campaign_criterion.proximity.address.city_name,
      metrics.clicks, metrics.impressions, metrics.conversions
    FROM location_view
    WHERE campaign.status != 'REMOVED' AND ${dateClause}`;

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
  const excluded = [];
  const geoTargetIds = new Set();

  lvRows.forEach((r) => {
    const cc = r.campaignCriterion || {};
    const m = r.metrics || {};
    const isNeg = cc.negative === true;
    const base = {
      campaign: r.campaign?.name || "",
      campaignId: String(r.campaign?.id || ""),
      status: r.campaign?.status || "",
      clicks: Number(m.clicks) || 0,
      impressions: Number(m.impressions) || 0,
      conversions: Number(m.conversions) || 0,
    };
    if (cc.type === "PROXIMITY" && cc.proximity) {
      const gp = cc.proximity.geoPoint || {};
      const lat = gp.latitudeInMicroDegrees != null ? gp.latitudeInMicroDegrees / 1e6 : null;
      const lng = gp.longitudeInMicroDegrees != null ? gp.longitudeInMicroDegrees / 1e6 : null;
      // Proximity is positive-only in Google Ads, but guard anyway.
      if (!isNeg) radius.push({
        ...base,
        lat, lng,
        radius: Number(cc.proximity.radius) || 0,
        radiusUnits: cc.proximity.radiusUnits || "KILOMETERS",
        city: cc.proximity.address?.cityName || "",
      });
    } else if (cc.type === "LOCATION" && cc.location?.geoTargetConstant) {
      const gid = idOf(cc.location.geoTargetConstant);
      geoTargetIds.add(cc.location.geoTargetConstant);
      (isNeg ? excluded : locations).push({ ...base, geoTargetId: gid, geoTargetConstant: cc.location.geoTargetConstant, name: "", negative: isNeg });
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
      [...locations, ...excluded].forEach((l) => {
        const n = nameMap.get(l.geoTargetConstant);
        l.canonical = n ? (n.canonical || n.name) : "";
        l.name = (n && (n.canonical || n.name)) || ("Location " + l.geoTargetId);
      });
    } catch (e) {
      nameError = String(e && e.message ? e.message : e);
      [...locations, ...excluded].forEach((l) => { if (!l.name) l.name = "Location " + l.geoTargetId; });
    }
  }

  // Boundary geometry for named (positive) targets, via OpenStreetMap/Nominatim.
  // The Ads API has no geometry for geo target constants, so this is the shape source.
  const geomDiag = [];
  const uniq = new Map(); // geoTargetConstant -> first location row
  locations.forEach((l) => { if (l.geoTargetConstant && !uniq.has(l.geoTargetConstant)) uniq.set(l.geoTargetConstant, l); });
  const targets = [...uniq.values()].slice(0, 30);
  for (const l of targets) {
    const g = await geocodeBoundary(l.canonical || l.name);
    geomDiag.push({ name: l.name, status: g.status, type: g.geometry?.type });
    locations.forEach((row) => {
      if (row.geoTargetConstant === l.geoTargetConstant) { row.geometry = g.geometry || null; row.center = g.center || null; }
    });
  }

  const payload = { radius, locations, excluded };
  if (debug) {
    payload.diag = {
      locationViewRows: lvRows.length,
      proximityCount: radius.length,
      proximityWithGeoPoint: radius.filter((b) => b.lat != null && b.lng != null).length,
      locationCount: locations.length,
      excludedCount: excluded.length,
      nameError: nameError ? nameError.slice(0, 300) : undefined,
      geocode: geomDiag,
      sample: lvRows.slice(0, 3).map((r) => ({ type: r.campaignCriterion?.type, negative: r.campaignCriterion?.negative, campaign: r.campaign?.name, clicks: r.metrics?.clicks })),
    };
  }
  return json(payload);
}

// Per-isolate cache so repeated locations aren't re-fetched within a warm worker.
const _geoCache = new Map();
async function geocodeBoundary(query) {
  if (!query) return { status: "empty" };
  if (_geoCache.has(query)) return _geoCache.get(query);
  let out;
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&polygon_geojson=1&limit=1&countrycodes=gb,ie&q=" + encodeURIComponent(query);
    const res = await fetch(url, { headers: { "User-Agent": "AdLytics/1.0 (https://anthonytierney.co.uk)", "Accept-Language": "en-GB" } });
    if (!res.ok) out = { status: "http_" + res.status };
    else {
      const arr = await res.json();
      if (!arr.length) out = { status: "not_found" };
      else {
        const hit = arr[0];
        const geometry = hit.geojson && /Polygon$/.test(hit.geojson.type) ? hit.geojson : null;
        out = { status: geometry ? "ok" : "point_only", geometry, center: { lat: Number(hit.lat), lng: Number(hit.lon) } };
      }
    }
  } catch (e) {
    out = { status: "error", message: String(e && e.message ? e.message : e).slice(0, 120) };
  }
  _geoCache.set(query, out);
  return out;
}

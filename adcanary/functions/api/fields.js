// GET /api/fields[?resource=user_location_view,location_view,geographic_view]
// Asks Google's own GoogleAdsFieldService which metrics and segments each report (resource)
// accepts, so we know for certain what can be shown alongside locations.
// Needs the dashboard sign-in. Read-only. Returns pretty-printed JSON:
//   { checkedAt, impressionShare: { <metric>: { <resource>: true|false } },
//     resources: { <resource>: { metrics: [...], segments: [...], attributedResources: [...] } } }

import { getRefreshToken, getAccessToken, adsRequest } from "../../shared/google.js";

const DEFAULT_RESOURCES = ["user_location_view", "location_view", "geographic_view"];
const IS_METRICS = [
  "metrics.search_impression_share",
  "metrics.search_top_impression_share",
  "metrics.search_absolute_top_impression_share",
  "metrics.search_budget_lost_impression_share",
  "metrics.search_rank_lost_impression_share",
  "metrics.search_click_share",
];

const pretty = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

export async function onRequestGet(context) {
  const { request, env } = context;
  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return pretty({ error: "Not signed in — open the dashboard and sign in first." }, 401);

  const url = new URL(request.url);
  const asked = (url.searchParams.get("resource") || "").split(",").map((s) => s.trim()).filter((s) => /^[a-z_]+$/.test(s));
  const resources = (asked.length ? asked : DEFAULT_RESOURCES).slice(0, 8);

  const accessToken = await getAccessToken(env, refreshToken);
  const fieldSearch = (query) => adsRequest(env, accessToken, "googleAdsFields:search", { query });

  const out = { checkedAt: new Date().toISOString(), impressionShare: {}, resources: {} };
  try {
    const list = resources.map((r) => `'${r}'`).join(", ");
    const res = await fieldSearch(`SELECT name, category, metrics, segments, attribute_resources WHERE name IN (${list})`);
    (res.results || []).forEach((f) => {
      out.resources[f.name] = {
        metrics: (f.metrics || []).slice().sort(),
        segments: (f.segments || []).slice().sort(),
        attributedResources: (f.attributeResources || []).slice().sort(),
      };
    });
    resources.forEach((r) => { if (!out.resources[r]) out.resources[r] = { error: "Not found in the field service" }; });
  } catch (e) {
    return pretty({ error: "Field lookup failed", detail: String(e && e.message ? e.message : e).slice(0, 500) }, 500);
  }

  // Straight answer to "can I get impression share by location?"
  IS_METRICS.forEach((m) => {
    out.impressionShare[m] = {};
    resources.forEach((r) => { const ms = out.resources[r].metrics; out.impressionShare[m][r] = Array.isArray(ms) ? ms.includes(m) : null; });
  });
  return pretty(out);
}

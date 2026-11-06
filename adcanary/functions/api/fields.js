// GET /api/fields[?resource=user_location_view,location_view,geographic_view]
// GET /api/fields?metric=search_impression_share[,search_click_share,...]
//     → for each metric, every resource and segment Google says it can be combined with,
//       with the geographic ones pulled out, i.e. "can I split this metric by location anywhere?"
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

  const metricParam = url.searchParams.get("metric");
  if (metricParam !== null) {
    const names = (metricParam || "search_impression_share").split(",").map((s) => s.trim().replace(/^metrics\./, "")).filter((s) => /^[a-z_]+$/.test(s)).slice(0, 10)
      .map((s) => "metrics." + s);
    try {
      const res = await fieldSearch(`SELECT name, selectable_with WHERE name IN (${names.map((n) => `'${n}'`).join(", ")})`);
      const metrics = {};
      (res.results || []).forEach((f) => {
        const sw = (f.selectableWith || []).slice().sort();
        const isGeo = (x) => /geo_target|location|geographic/.test(x);
        metrics[f.name] = {
          geographicCombinations: sw.filter(isGeo),
          canSplitByLocation: sw.some(isGeo),
          resources: sw.filter((x) => !x.includes(".")),
          segments: sw.filter((x) => x.startsWith("segments.")),
        };
      });
      names.forEach((n) => { if (!metrics[n]) metrics[n] = { error: "Not found in the field service" }; });
      return pretty({ checkedAt: new Date().toISOString(), metrics });
    } catch (e) {
      return pretty({ error: "Field lookup failed", detail: String(e && e.message ? e.message : e).slice(0, 500) }, 500);
    }
  }

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

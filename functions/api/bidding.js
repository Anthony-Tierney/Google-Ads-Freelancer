// GET /api/bidding?customerId=1234567890
// For each non-removed campaign: bidding strategy, target CPA (if any), and the CPA
// achieved over the last 14 days (excluding today, per LAST_14_DAYS).
//   { campaigns: [{ id, name, status, type, biddingStrategy, targetCpa, cpaAchieved }], metricError }

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

  // change_event needs a finite YYYY-MM-DD range with start within 30 days (28 back for buffer).
  const MS_DAY = 86400000;
  const changeStart = new Date(Date.now() - 28 * MS_DAY).toISOString().slice(0, 10);
  const changeEnd = new Date(Date.now() + MS_DAY).toISOString().slice(0, 10);

  const [campR, metricR, changeR] = await Promise.allSettled([
    search(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.status != 'REMOVED'`),
    // Daily-segmented so we can sum cost/conversions from each campaign's last adjustment date onward.
    search(`SELECT campaign.id, segments.date, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.status != 'REMOVED'`),
    // Campaign-level changes; we keep the most recent that touched a target CPA field.
    search(`SELECT change_event.change_date_time, change_event.change_resource_type, change_event.campaign, change_event.changed_fields FROM change_event WHERE change_event.change_date_time >= '${changeStart}' AND change_event.change_date_time <= '${changeEnd}' AND change_event.change_resource_type = 'CAMPAIGN' ORDER BY change_event.change_date_time DESC LIMIT 10000`),
  ]);

  if (campR.status !== "fulfilled") {
    const e = campR.reason;
    return json({ error: (e && e.message) ? e.message : "Could not load campaigns" }, 500);
  }

  const campaigns = {};
  (campR.value.results || []).forEach((r) => {
    const id = String(r.campaign?.id);
    const targetMicros =
      r.campaign?.targetCpa?.targetCpaMicros ??
      r.campaign?.maximizeConversions?.targetCpaMicros ??
      null;
    campaigns[id] = {
      id,
      name: r.campaign?.name,
      status: r.campaign?.status,
      type: r.campaign?.advertisingChannelType,
      biddingStrategy: r.campaign?.biddingStrategyType,
      targetCpa: targetMicros != null ? Number(targetMicros) / 1e6 : null,
      lastAdjusted: null,
      daily: [],
    };
  });

  // Last Target-CPA change per campaign (change history spans ~30 days only)
  let changeError = null;
  if (changeR.status === "fulfilled") {
    (changeR.value.results || []).forEach((r) => {
      const camp = r.changeEvent?.campaign;
      if (!camp) return;
      const c = campaigns[camp.split("/").pop()];
      if (!c || c.lastAdjusted) return;
      const fields = (r.changeEvent?.changedFields || "").toLowerCase();
      if (!fields.includes("targetcpa")) return; // only target CPA changes
      c.lastAdjusted = (r.changeEvent?.changeDateTime || "").slice(0, 10);
    });
  } else {
    const e = changeR.reason;
    changeError = (e && e.message) ? e.message : "Could not load change history";
  }

  let metricError = null;
  if (metricR.status === "fulfilled") {
    (metricR.value.results || []).forEach((r) => {
      const c = campaigns[String(r.campaign?.id)];
      if (!c) return;
      c.daily.push({
        date: r.segments?.date,
        cost: Number(r.metrics?.costMicros || 0) / 1e6,
        conv: Number(r.metrics?.conversions || 0),
      });
    });
  } else {
    const msg = (metricR.reason && metricR.reason.message) ? metricR.reason.message : "Could not load performance";
    // Manager (MCC) accounts have no campaign metrics — that's expected, not an error.
    if (!/REQUESTED_METRICS_FOR_MANAGER/.test(msg)) metricError = msg;
  }

  const out = Object.values(campaigns).map((c) => {
    // CPA achieved since the last target-CPA adjustment (or across the 30-day window
    // when the last change predates our 30-day history / there's no target).
    const start = c.lastAdjusted; // 'YYYY-MM-DD' or null
    let cost = 0, conv = 0;
    for (const d of c.daily) {
      if (start && (d.date || "") < start) continue;
      cost += d.cost;
      conv += d.conv;
    }
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      type: c.type,
      biddingStrategy: c.biddingStrategy,
      targetCpa: c.targetCpa,
      lastAdjusted: c.lastAdjusted,
      cpaAchieved: conv > 0 ? cost / conv : null,
    };
  });

  return json({ campaigns: out, metricError, changeError });
}

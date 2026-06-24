// GET /api/underspend?customerId=1234567890
// For each non-removed campaign, returns daily budget, the date of the last budget
// change (from change history, which only spans the last 30 days), average daily
// spend since that change, whether underspend is detected, and the cumulative
// "bank" of underspend (budgeted minus actual since the last change).
//
//   { campaigns: [{ id, name, status, type, dailyBudget, lastAdjusted, daysSince,
//                   dailySpend, totalSpend, underspend, bank }], spendError, changeError }

import {
  getRefreshToken,
  getAccessToken,
  adsRequest,
  json,
} from "../../shared/google.js";

const MS_DAY = 86400000;
const UNDERSPEND_THRESHOLD = 0.9; // avg daily spend below 90% of budget = underspend

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

  // Run the three independent queries in parallel.
  const [campR, spendR, changeR] = await Promise.allSettled([
    search(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'`),
    search(`SELECT campaign.id, segments.date, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_30_DAYS AND campaign.status != 'REMOVED'`),
    search(`SELECT change_event.change_date_time, change_event.change_resource_type, change_event.campaign, change_event.changed_fields FROM change_event WHERE change_event.change_date_time DURING LAST_30_DAYS AND change_event.change_resource_type = 'CAMPAIGN_BUDGET' ORDER BY change_event.change_date_time DESC LIMIT 10000`),
  ]);

  if (campR.status !== "fulfilled") {
    const e = campR.reason;
    return json({ error: (e && e.message) ? e.message : "Could not load campaigns" }, 500);
  }

  const campaigns = {};
  (campR.value.results || []).forEach((r) => {
    const id = String(r.campaign?.id);
    campaigns[id] = {
      id,
      name: r.campaign?.name,
      status: r.campaign?.status,
      type: r.campaign?.advertisingChannelType,
      dailyBudget: Number(r.campaignBudget?.amountMicros || 0) / 1e6,
      daily: {},
      lastAdjusted: null,
    };
  });

  // Daily spend
  let spendError = null;
  if (spendR.status === "fulfilled") {
    (spendR.value.results || []).forEach((r) => {
      const c = campaigns[String(r.campaign?.id)];
      if (!c) return;
      const d = r.segments?.date;
      if (!d) return;
      c.daily[d] = (c.daily[d] || 0) + Number(r.metrics?.costMicros || 0) / 1e6;
    });
  } else {
    const e = spendR.reason;
    spendError = (e && e.message) ? e.message : "Could not load spend";
  }

  // Last budget change per campaign (results are ordered newest-first)
  let changeError = null;
  if (changeR.status === "fulfilled") {
    (changeR.value.results || []).forEach((r) => {
      const camp = r.changeEvent?.campaign;
      if (!camp) return;
      const c = campaigns[camp.split("/").pop()];
      if (!c || c.lastAdjusted) return;
      const fields = (r.changeEvent?.changedFields || "").toLowerCase();
      if (!fields.includes("amount")) return; // only budget-amount changes
      c.lastAdjusted = (r.changeEvent?.changeDateTime || "").slice(0, 10);
    });
  } else {
    const e = changeR.reason;
    changeError = (e && e.message) ? e.message : "Could not load change history";
  }

  // Compute metrics
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayMs = Date.parse(todayStr + "T00:00:00Z");
  const fallbackStart = new Date(todayMs - 29 * MS_DAY).toISOString().slice(0, 10);

  const out = Object.values(campaigns).map((c) => {
    const windowStart = c.lastAdjusted || fallbackStart;
    const startMs = Date.parse(windowStart + "T00:00:00Z");
    const daysSince = Math.max(1, Math.round((todayMs - startMs) / MS_DAY) + 1);

    let totalSpend = 0;
    for (const [d, cost] of Object.entries(c.daily)) {
      if (d >= windowStart) totalSpend += cost;
    }

    const dailySpend = totalSpend / daysSince;
    const expected = c.dailyBudget * daysSince;
    const bank = Math.max(0, expected - totalSpend);
    const underspend = c.dailyBudget > 0 && dailySpend < c.dailyBudget * UNDERSPEND_THRESHOLD;

    return {
      id: c.id,
      name: c.name,
      status: c.status,
      type: c.type,
      dailyBudget: c.dailyBudget,
      lastAdjusted: c.lastAdjusted,
      daysSince,
      dailySpend,
      totalSpend,
      underspend,
      bank,
    };
  });

  return json({ campaigns: out, spendError, changeError });
}

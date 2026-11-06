// shared/changes.js — account change history for graph annotations.
//
// Google's change_event report only covers the last 30 days, so every change we see is also
// saved to KV (`annlog:v1:<customerId>`), building a permanent log from the day this went live.
// The log is topped up whenever someone views annotations, and daily by the digest cron.
//
// Normalised change:
//   { id, ts: "YYYY-MM-DD HH:MM:SS", date: "YYYY-MM-DD",
//     type: "budget" | "bidding" | "status",
//     campaigns: [{ id, name }],      // campaigns affected (a shared budget/portfolio → several)
//     label,                          // e.g. "Daily budget", "Target CPA", "Bid strategy", "Status"
//     from, to, unit: "money" | "pct" | "text",
//     scope?,                         // e.g. portfolio or shared budget name
//     user, source }                  // who / what made it

const LOG_KEY = (cid) => "annlog:v1:" + cid;
const NOTES_KEY = (cid) => "annnotes:v1:" + cid;
const LOG_CAP = 4000;
const NOTES_CAP = 1000;

const STRATEGY_NAMES = {
  manualCpc: "Manual CPC", manualCpm: "Manual CPM", manualCpv: "Manual CPV", manualCpa: "Manual CPA",
  maximizeConversions: "Maximise conversions", maximizeConversionValue: "Maximise conversion value",
  targetCpa: "Target CPA", targetRoas: "Target ROAS", targetSpend: "Maximise clicks",
  targetImpressionShare: "Target impression share", targetCpm: "Target CPM", targetCpv: "Target CPV",
  percentCpc: "Percent CPC", commission: "Commission", fixedCpm: "Fixed CPM",
};
const STRATEGY_KEYS = Object.keys(STRATEGY_NAMES);
const SOURCE_NAMES = {
  GOOGLE_ADS_WEB_CLIENT: "Google Ads", GOOGLE_ADS_AUTOMATED_RULE: "Automated rule", GOOGLE_ADS_SCRIPTS: "Google Ads script",
  GOOGLE_ADS_BULK_UPLOAD: "Bulk upload", GOOGLE_ADS_API: "Google Ads API", GOOGLE_ADS_EDITOR: "Google Ads Editor",
  GOOGLE_ADS_MOBILE_APP: "Google Ads app", GOOGLE_ADS_RECOMMENDATIONS: "Auto-applied recommendation",
  GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION: "Auto-applied recommendation", SEARCH_ADS_360_SYNC: "Search Ads 360",
  SEARCH_ADS_360_POST: "Search Ads 360", INTERNAL_TOOL: "Google", OTHER: "Other",
};

const idOf = (rn) => String(rn || "").split("/").pop();
const micros = (v) => (v == null || v === "" ? null : Number(v) / 1e6);
const fieldsOf = (cf) => String(cf || "").split(",").map((f) => f.trim().replace(/_([a-z])/g, (m, c) => c.toUpperCase())).filter(Boolean);

function strategyOf(c) {
  if (!c) return null;
  for (const k of STRATEGY_KEYS) if (c[k] !== undefined) return k;
  if (c.biddingStrategy) return "portfolio";
  return null;
}
function tcpaOf(o) { if (!o) return null; const v = o.targetCpa?.targetCpaMicros ?? o.maximizeConversions?.targetCpaMicros; return v == null ? null : micros(v); }
function troasOf(o) { if (!o) return null; const v = o.targetRoas?.targetRoas ?? o.maximizeConversionValue?.targetRoas; return v == null ? null : Number(v); }

// Pull and normalise changes between two dates (YYYY-MM-DD, both within Google's 30-day window).
// Turn a Google Ads API error into its specific reason (the first line is usually just
// "Request contains an invalid argument"; the useful part is in details[].errors[]).
export function adsErrorReason(e) {
  const msg = String(e && e.message ? e.message : e);
  const msgs = [...msg.matchAll(/"message":\s*"([^"]+)"/g)].map((m) => m[1]).filter((m) => !/invalid argument/i.test(m));
  const code = /"errorCode":\s*\{\s*"(\w+)":\s*"(\w+)"/.exec(msg);
  const parts = [];
  if (code) parts.push(code[1] + ": " + code[2]);
  if (msgs.length) parts.push(msgs[msgs.length - 1]);
  return parts.length ? parts.join(" \u2014 ") : msg.slice(0, 200);
}

export async function fetchChanges(search, startDate, endDate) {
  // Note: change_event only reports certain resource types — campaigns and campaign budgets are
  // in, portfolio bidding strategies are NOT (asking for BIDDING_STRATEGY rejects the whole query).
  const FIELDS = `change_event.resource_name, change_event.change_date_time, change_event.change_resource_type,
      change_event.change_resource_name, change_event.resource_change_operation, change_event.changed_fields,
      change_event.old_resource, change_event.new_resource, change_event.user_email, change_event.client_type`;
  const RANGE = `change_event.change_date_time >= '${startDate}' AND change_event.change_date_time <= '${endDate}'`;
  let evRows, firstErr;
  try {
    evRows = await search(`SELECT ${FIELDS}, change_event.campaign FROM change_event
      WHERE ${RANGE} AND change_event.change_resource_type IN ('CAMPAIGN', 'CAMPAIGN_BUDGET')
      ORDER BY change_event.change_date_time DESC LIMIT 10000`);
  } catch (e) {
    // Fallback: simplest form of the query; filter and sort here instead.
    firstErr = e;
    try {
      evRows = (await search(`SELECT ${FIELDS} FROM change_event WHERE ${RANGE} LIMIT 10000`))
        .filter((r) => ["CAMPAIGN", "CAMPAIGN_BUDGET"].includes(r.changeEvent?.changeResourceType))
        .sort((a, b) => (String(a.changeEvent?.changeDateTime) < String(b.changeEvent?.changeDateTime) ? 1 : -1));
    } catch { throw new Error(adsErrorReason(firstErr)); }
  }
  if (!evRows.length) return [];

  // Campaign names, plus which campaigns use each budget / portfolio strategy.
  const campName = new Map(), byBudget = new Map(), byPortfolio = new Map(), budgetAmt = new Map(), budgetName = new Map();
  try {
    (await search(`SELECT campaign.id, campaign.name, campaign.campaign_budget, campaign.bidding_strategy, campaign_budget.amount_micros, campaign_budget.name FROM campaign`))
      .forEach((r) => {
        const c = r.campaign || {}, id = String(c.id || "");
        campName.set(id, c.name || "");
        const add = (map, k) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push({ id, name: c.name || "" }); };
        add(byBudget, c.campaignBudget); add(byPortfolio, c.biddingStrategy);
        if (c.campaignBudget) { budgetAmt.set(c.campaignBudget, micros(r.campaignBudget?.amountMicros)); budgetName.set(c.campaignBudget, r.campaignBudget?.name || ""); }
      });
  } catch { /* names fall back to ids */ }
  let portfolioName = new Map();
  if (evRows.some((r) => r.changeEvent?.changeResourceType === "BIDDING_STRATEGY")) {
    try { (await search(`SELECT bidding_strategy.resource_name, bidding_strategy.name FROM bidding_strategy`)).forEach((r) => portfolioName.set(r.biddingStrategy?.resourceName, r.biddingStrategy?.name || "")); } catch {}
  }

  const out = [];
  for (const r of evRows) {
    const e = r.changeEvent || {};
    if (e.resourceChangeOperation && e.resourceChangeOperation !== "UPDATE") continue; // creations/removals of whole resources aren't "levers"
    const ts = String(e.changeDateTime || "").slice(0, 19), date = ts.slice(0, 10);
    const fields = fieldsOf(e.changedFields).map((f) => f.toLowerCase());
    const has = (s) => fields.some((f) => f.includes(s.toLowerCase()));
    const base = { ts, date, user: e.userEmail || "", source: SOURCE_NAMES[e.clientType] || "" };
    const push = (suffix, ev) => out.push({ id: (e.resourceName || ts) + "#" + suffix, ...base, ...ev });
    const oldR = e.oldResource || {}, newR = e.newResource || {};

    if (e.changeResourceType === "CAMPAIGN_BUDGET") {
      const o = oldR.campaignBudget || {}, n = newR.campaignBudget || {};
      const from = micros(o.amountMicros), to = micros(n.amountMicros);
      if (has("amount") && to != null && from !== to) {
        const camps = byBudget.get(e.changeResourceName) || (e.campaign ? [{ id: idOf(e.campaign), name: campName.get(idOf(e.campaign)) || "" }] : []);
        push("budget", { type: "budget", campaigns: camps, label: "Daily budget", from, to, unit: "money", scope: camps.length > 1 ? (budgetName.get(e.changeResourceName) || "Shared budget") : "" });
      }
      continue;
    }

    if (e.changeResourceType === "BIDDING_STRATEGY") {
      const o = oldR.biddingStrategy || {}, n = newR.biddingStrategy || {};
      const camps = byPortfolio.get(e.changeResourceName) || [];
      const scope = portfolioName.get(e.changeResourceName) || n.name || o.name || "Portfolio strategy";
      const tc0 = tcpaOf(o), tc1 = tcpaOf(n), tr0 = troasOf(o), tr1 = troasOf(n);
      if (tc1 != null && tc0 !== tc1) push("tcpa", { type: "bidding", campaigns: camps, label: "Target CPA", from: tc0, to: tc1, unit: "money", scope });
      if (tr1 != null && tr0 !== tr1) push("troas", { type: "bidding", campaigns: camps, label: "Target ROAS", from: tr0, to: tr1, unit: "pct", scope });
      const s0 = strategyOf(o), s1 = strategyOf(n);
      if (s1 && s0 !== s1) push("strategy", { type: "bidding", campaigns: camps, label: "Bid strategy", from: s0 ? STRATEGY_NAMES[s0] || s0 : null, to: STRATEGY_NAMES[s1] || s1, unit: "text", scope });
      continue;
    }

    // CAMPAIGN
    const o = oldR.campaign || {}, n = newR.campaign || {};
    const cid = idOf(e.campaign || e.changeResourceName); // changeResourceName = customers/x/campaigns/<id>
    const camps = [{ id: cid, name: campName.get(cid) || n.name || o.name || "Campaign " + cid }];
    if (has("status") && n.status && o.status !== n.status) {
      const word = { ENABLED: "Enabled", PAUSED: "Paused", REMOVED: "Removed" };
      push("status", { type: "status", campaigns: camps, label: "Status", from: word[o.status] || o.status || null, to: word[n.status] || n.status, unit: "text" });
    }
    let s0 = strategyOf(o), s1 = strategyOf(n);
    const stratChanged = STRATEGY_KEYS.some((k) => has(k)) || has("biddingStrategy");
    if (stratChanged && s1 && s0 !== s1) {
      const nm = (s) => (s === "portfolio" ? "Portfolio strategy" : STRATEGY_NAMES[s] || s);
      push("strategy", { type: "bidding", campaigns: camps, label: "Bid strategy", from: s0 ? nm(s0) : null, to: nm(s1), unit: "text" });
    }
    const tc0 = tcpaOf(o), tc1 = tcpaOf(n);
    if (has("targetCpaMicros") && tc1 != null && tc0 !== tc1) push("tcpa", { type: "bidding", campaigns: camps, label: "Target CPA", from: tc0, to: tc1, unit: "money" });
    const tr0 = troasOf(o), tr1 = troasOf(n);
    if (has("targetRoas") && tr1 != null && tr0 !== tr1) push("troas", { type: "bidding", campaigns: camps, label: "Target ROAS", from: tr0, to: tr1, unit: "pct" });
    if (has("campaignBudget") && n.campaignBudget && o.campaignBudget !== n.campaignBudget) {
      push("budgetswap", { type: "budget", campaigns: camps, label: "Budget switched", from: budgetAmt.get(o.campaignBudget) ?? null, to: budgetAmt.get(n.campaignBudget) ?? null, unit: "money", scope: budgetName.get(n.campaignBudget) || "" });
    }
  }
  return out;
}

// The window Google can still answer for: the last 28 days (a safe margin inside 30) up to tomorrow.
export function liveWindow() {
  const DAY = 86400000;
  return { start: new Date(Date.now() - 28 * DAY).toISOString().slice(0, 10), end: new Date(Date.now() + DAY).toISOString().slice(0, 10) };
}

export async function readLog(env, cid) {
  try { return (await env.SESSIONS.get(LOG_KEY(cid), "json")) || { since: null, events: [] }; } catch { return { since: null, events: [] }; }
}

// Merge freshly fetched changes into the saved log. `windowStart` = earliest date the fetch covered.
export async function mergeIntoLog(env, cid, fresh, windowStart) {
  const log = await readLog(env, cid);
  const seen = new Set(log.events.map((e) => e.id));
  const added = fresh.filter((e) => !seen.has(e.id));
  const since = !log.since || (windowStart && windowStart < log.since) ? windowStart : log.since;
  if (added.length || since !== log.since) {
    log.events = log.events.concat(added).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, LOG_CAP);
    log.since = since;
    try { await env.SESSIONS.put(LOG_KEY(cid), JSON.stringify(log)); } catch {}
  }
  return log;
}

// Fetch the live window and save it — used by the digest cron to keep every account's log current.
export async function refreshLog(env, search, cid) {
  const w = liveWindow();
  const fresh = await fetchChanges(search, w.start, w.end);
  return mergeIntoLog(env, cid, fresh, w.start);
}

export async function readNotes(env, cid) {
  try { return (await env.SESSIONS.get(NOTES_KEY(cid), "json")) || []; } catch { return []; }
}
export async function writeNotes(env, cid, notes) {
  await env.SESSIONS.put(NOTES_KEY(cid), JSON.stringify(notes.slice(-NOTES_CAP)));
}

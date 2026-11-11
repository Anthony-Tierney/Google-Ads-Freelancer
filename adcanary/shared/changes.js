// shared/changes.js — account change history for graph annotations.
//
// Google's change_event report only covers the last 30 days, so every change we see is also
// saved to KV (`annlog:v1:<customerId>`), building a permanent log from the day this went live.
// The log is topped up whenever someone views annotations, and daily by the digest cron.
//
// Normalised change:
//   { id, ts: "YYYY-MM-DD HH:MM:SS", date: "YYYY-MM-DD",
//     type: "budget" | "bidding" | "status" | "landing",
//     campaigns: [{ id, name }],      // campaigns affected (a shared budget/portfolio → several)
//     label,                          // e.g. "Daily budget", "Target CPA", "Bid strategy", "Status"
//     from, to, unit: "money" | "pct" | "text" | "url",
//     scope?,                         // e.g. portfolio or shared budget name, sitelink text
//     adGroup?,                       // landing page changes: the ad group involved
//     user, source }                  // who / what made it
//
// Landing pages come from two places:
//   1. Google's change history — ad final URL edits, new ads using a URL that ad group hasn't used
//      before, and sitelink / other asset URL edits (with who made them).
//   2. A daily snapshot of every live landing page per campaign (ads, Performance Max asset groups,
//      sitelinks), compared with the previous day — catches anything the history doesn't cover,
//      notably Performance Max. Skipped where the change history already recorded the same change.

const LOG_KEY = (cid) => "annlog:v1:" + cid;
const NOTES_KEY = (cid) => "annnotes:v1:" + cid;
const LOG_CAP = 8000;
const SNAP_KEY = (cid) => "lpsnap:v1:" + cid;
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
// Compare URLs loosely: case-insensitive host, no trailing slash.
export const normUrl = (u) => String(u || "").trim().replace(/^(https?:\/\/[^/?#]+)/i, (m) => m.toLowerCase()).replace(/\/+(?=$|[?#])/, "");
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
      WHERE ${RANGE} AND change_event.change_resource_type IN ('CAMPAIGN', 'CAMPAIGN_BUDGET', 'AD', 'AD_GROUP_AD', 'ASSET')
      ORDER BY change_event.change_date_time DESC LIMIT 10000`);
  } catch (e) {
    // Fallback: simplest form of the query; filter and sort here instead.
    firstErr = e;
    try {
      evRows = (await search(`SELECT ${FIELDS} FROM change_event WHERE ${RANGE} LIMIT 10000`))
        .filter((r) => ["CAMPAIGN", "CAMPAIGN_BUDGET", "AD", "AD_GROUP_AD", "ASSET"].includes(r.changeEvent?.changeResourceType))
        .sort((a, b) => (String(a.changeEvent?.changeDateTime) < String(b.changeEvent?.changeDateTime) ? 1 : -1));
    } catch { throw new Error(adsErrorReason(firstErr)); }
  }
  if (!evRows.length) return [];
  // Ad / asset events only matter when they touch a URL — drop the rest early.
  evRows = evRows.filter((r) => {
    const e = r.changeEvent || {};
    if (!["AD", "AD_GROUP_AD", "ASSET"].includes(e.changeResourceType)) return true;
    if (e.changeResourceType === "AD_GROUP_AD") return e.resourceChangeOperation === "CREATE";
    return e.resourceChangeOperation === "UPDATE" && /final_?urls/i.test(String(e.changedFields || ""));
  });
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
  // Landing page lookups: every ad (any status, so a re-created ad using an existing URL isn't
  // mistaken for a new page), ad group names/parents, and which campaigns each asset is linked to.
  const adInfo = new Map(), agInfo = new Map(), assetCamps = new Map(), assetField = new Map(), assetText = new Map();
  const needAds = evRows.some((r) => ["AD", "AD_GROUP_AD"].includes(r.changeEvent?.changeResourceType));
  const assetRns = [...new Set(evRows.filter((r) => r.changeEvent?.changeResourceType === "ASSET").map((r) => r.changeEvent.changeResourceName).filter(Boolean))].slice(0, 300);
  const assetIds = assetRns.map(idOf);
  if (needAds || assetIds.length) {
    try { (await search(`SELECT ad_group.id, ad_group.name, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED'`)).forEach((r) => agInfo.set(String(r.adGroup?.id), { name: r.adGroup?.name || "", campId: String(r.campaign?.id || "") })); } catch {}
  }
  if (needAds) {
    try {
      (await search(`SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group.id, campaign.id FROM ad_group_ad`)).forEach((r) => {
        adInfo.set(String(r.adGroupAd?.ad?.id), { url: normUrl((r.adGroupAd?.ad?.finalUrls || [])[0]), raw: (r.adGroupAd?.ad?.finalUrls || [])[0] || "", agId: String(r.adGroup?.id || ""), campId: String(r.campaign?.id || "") });
      });
    } catch {}
  }
  if (assetIds.length) {
    const inList = (field) => `${field} IN (${assetRns.map((rn) => `'${rn}'`).join(", ")})`;
    const link = (id, camp, ft) => { if (!assetCamps.has(id)) assetCamps.set(id, new Map()); if (camp) assetCamps.get(id).set(camp.id, camp); if (ft && !assetField.has(id)) assetField.set(id, ft); };
    try { (await search(`SELECT campaign_asset.campaign, campaign_asset.asset, campaign_asset.field_type FROM campaign_asset WHERE campaign_asset.status != 'REMOVED' AND ${inList("campaign_asset.asset")}`)).forEach((r) => { const c = idOf(r.campaignAsset?.campaign); link(idOf(r.campaignAsset?.asset), { id: c, name: campName.get(c) || "" }, r.campaignAsset?.fieldType); }); } catch {}
    try { (await search(`SELECT ad_group_asset.ad_group, ad_group_asset.asset, ad_group_asset.field_type FROM ad_group_asset WHERE ad_group_asset.status != 'REMOVED' AND ${inList("ad_group_asset.asset")}`)).forEach((r) => { const ag = agInfo.get(idOf(r.adGroupAsset?.adGroup)); link(idOf(r.adGroupAsset?.asset), ag ? { id: ag.campId, name: campName.get(ag.campId) || "" } : null, r.adGroupAsset?.fieldType); }); } catch {}
    try { (await search(`SELECT customer_asset.asset, customer_asset.field_type FROM customer_asset WHERE customer_asset.status != 'REMOVED' AND ${inList("customer_asset.asset")}`)).forEach((r) => { const id = idOf(r.customerAsset?.asset); link(id, null, r.customerAsset?.fieldType); if (!assetCamps.get(id).has("account")) assetCamps.get(id).set("account", null); }); } catch {}
    try { (await search(`SELECT asset.id, asset.sitelink_asset.link_text FROM asset WHERE asset.id IN (${assetIds.join(", ")})`)).forEach((r) => assetText.set(String(r.asset?.id), r.asset?.sitelinkAsset?.linkText || "")); } catch {}
  }
  let portfolioName = new Map();
  if (evRows.some((r) => r.changeEvent?.changeResourceType === "BIDDING_STRATEGY")) {
    try { (await search(`SELECT bidding_strategy.resource_name, bidding_strategy.name FROM bidding_strategy`)).forEach((r) => portfolioName.set(r.biddingStrategy?.resourceName, r.biddingStrategy?.name || "")); } catch {}
  }

  const out = [];
  for (const r of evRows) {
    const e = r.changeEvent || {};
    const isNewAd = e.changeResourceType === "AD_GROUP_AD" && e.resourceChangeOperation === "CREATE";
    if (!isNewAd && e.resourceChangeOperation && e.resourceChangeOperation !== "UPDATE") continue; // creations/removals of whole resources aren't "levers"
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

    // ---- Landing pages ----
    if (e.changeResourceType === "AD") {                     // final URL edited on an existing ad
      const adId = idOf(e.changeResourceName), info = adInfo.get(adId) || {};
      const from = (oldR.ad?.finalUrls || [])[0] || "", to = (newR.ad?.finalUrls || [])[0] || "";
      if (to && normUrl(from) !== normUrl(to)) {
        const ag = agInfo.get(info.agId) || {}, campId = info.campId || ag.campId || idOf(e.campaign);
        push("adurl", { type: "landing", campaigns: [{ id: campId, name: campName.get(campId) || "" }], adGroup: ag.name || "", label: "Ad URL", from: from || null, to, unit: "url" });
      }
      continue;
    }
    if (isNewAd) {                                            // new ad — only if its URL is new to that ad group
      const adId = String(e.changeResourceName || "").split("~").pop(), info = adInfo.get(adId) || {};
      const raw = (newR.adGroupAd?.ad?.finalUrls || [])[0] || info.raw || "", url = normUrl(raw);
      const agId = info.agId || String(e.changeResourceName || "").split("/").pop().split("~")[0];
      const usedBefore = [...adInfo.entries()].some(([id, a]) => id !== adId && a.agId === agId && a.url && a.url === url);
      if (url && !usedBefore) {
        const ag = agInfo.get(agId) || {}, campId = info.campId || ag.campId || idOf(e.campaign);
        push("newad", { type: "landing", campaigns: [{ id: campId, name: campName.get(campId) || "" }], adGroup: ag.name || "", label: "New ad", from: null, to: raw, unit: "url" });
      }
      continue;
    }
    if (e.changeResourceType === "ASSET") {                   // sitelink (or other asset) URL edited
      const aid = idOf(e.changeResourceName);
      const from = (oldR.asset?.finalUrls || [])[0] || "", to = (newR.asset?.finalUrls || [])[0] || "";
      if (to && normUrl(from) !== normUrl(to)) {
        const links = assetCamps.get(aid) || new Map();
        const camps = [...links.values()].filter(Boolean);
        const ft = assetField.get(aid) || (newR.asset?.sitelinkAsset || oldR.asset?.sitelinkAsset ? "SITELINK" : "");
        const kind = ft === "SITELINK" ? "Sitelink" : ft === "PROMOTION" ? "Promotion" : ft === "PRICE" ? "Price" : "Asset";
        push("asseturl", { type: "landing", campaigns: camps, label: kind + " URL", from: from || null, to, unit: "url",
          scope: [assetText.get(aid) || newR.asset?.sitelinkAsset?.linkText || "", links.has("account") ? "account-level" : ""].filter(Boolean).join(", ") });
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
  // Refresh campaign names on changes already saved (campaigns get renamed).
  const names = new Map();
  fresh.forEach((e) => (e.campaigns || []).forEach((x) => { if (x.id && x.name) names.set(String(x.id), x.name); }));
  let renamed = false;
  log.events.forEach((e) => (e.campaigns || []).forEach((x) => { const n = names.get(String(x.id)); if (n && n !== x.name) { x.name = n; renamed = true; } }));
  const seen = new Set(log.events.map((e) => e.id));
  const added = fresh.filter((e) => !seen.has(e.id));
  const since = !log.since || (windowStart && windowStart < log.since) ? windowStart : log.since;
  if (added.length || since !== log.since || renamed) {
    log.events = log.events.concat(added).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, LOG_CAP);
    log.since = since;
    try { await env.SESSIONS.put(LOG_KEY(cid), JSON.stringify(log)); } catch {}
  }
  return log;
}

// Daily landing page snapshot: every live landing page per campaign, compared with the previous
// snapshot. Runs at most once a day per account. Returns the (possibly updated) log.
export async function snapshotLandingPages(env, search, cid, log) {
  const today = new Date().toISOString().slice(0, 10);
  let prev = null;
  try { prev = await env.SESSIONS.get(SNAP_KEY(cid), "json"); } catch {}
  if (prev && prev.date === today) return log;

  const urls = new Map(); // campaignId | "account" -> Map(normUrl -> raw)
  const add = (camp, raw) => { const u = normUrl(raw); if (!u) return; if (!urls.has(camp)) urls.set(camp, new Map()); urls.get(camp).set(u, raw); };
  const names = new Map(), agCamp = new Map(), assetUrl = new Map();
  (await search(`SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status != 'REMOVED'`)).forEach((r) => names.set(String(r.campaign?.id), r.campaign?.name || ""));
  (await search(`SELECT campaign.id, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED' AND ad_group_ad.status = 'ENABLED'`))
    .forEach((r) => (r.adGroupAd?.ad?.finalUrls || []).forEach((u) => add(String(r.campaign?.id), u)));
  // Every lookup must succeed. If any one fails (e.g. Google times out, or the daily run hits
  // Cloudflare's request limit), the whole check is skipped for today rather than saving a partial
  // list — a partial list makes pages look "no longer used" one day and "new" the next.
  {
    (await search(`SELECT campaign.id, asset_group.final_urls FROM asset_group WHERE campaign.status != 'REMOVED' AND asset_group.status = 'ENABLED'`))
      .forEach((r) => (r.assetGroup?.finalUrls || []).forEach((u) => add(String(r.campaign?.id), u)));
    (await search(`SELECT asset.id, asset.final_urls FROM asset WHERE asset.type = 'SITELINK'`)).forEach((r) => assetUrl.set(String(r.asset?.id), r.asset?.finalUrls || []));
    (await search(`SELECT ad_group.id, campaign.id FROM ad_group WHERE ad_group.status != 'REMOVED'`)).forEach((r) => agCamp.set(String(r.adGroup?.id), String(r.campaign?.id)));
    (await search(`SELECT campaign_asset.campaign, campaign_asset.asset FROM campaign_asset WHERE campaign_asset.field_type = 'SITELINK' AND campaign_asset.status = 'ENABLED'`))
      .forEach((r) => (assetUrl.get(idOf(r.campaignAsset?.asset)) || []).forEach((u) => add(idOf(r.campaignAsset?.campaign), u)));
    (await search(`SELECT ad_group_asset.ad_group, ad_group_asset.asset FROM ad_group_asset WHERE ad_group_asset.field_type = 'SITELINK' AND ad_group_asset.status = 'ENABLED'`))
      .forEach((r) => { const c = agCamp.get(idOf(r.adGroupAsset?.adGroup)); if (c) (assetUrl.get(idOf(r.adGroupAsset?.asset)) || []).forEach((u) => add(c, u)); });
    (await search(`SELECT customer_asset.asset FROM customer_asset WHERE customer_asset.field_type = 'SITELINK' AND customer_asset.status = 'ENABLED'`))
      .forEach((r) => (assetUrl.get(idOf(r.customerAsset?.asset)) || []).forEach((u) => add("account", u)));
  }

  const snap = { date: today, map: Object.fromEntries([...urls].map(([k, m]) => [k, [...m.entries()]])) };
  try { await env.SESSIONS.put(SNAP_KEY(cid), JSON.stringify(snap)); } catch {}
  if (!prev || !prev.map) return log; // first snapshot: nothing to compare yet

  // Skip anything the change history already recorded in the last few days.
  const DAY = 86400000, since = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
  const known = new Set();
  (log.events || []).filter((e) => e.type === "landing" && e.date >= since && e.source !== "Daily check").forEach((e) => {
    (e.campaigns || []).forEach((c) => { if (e.to) known.add("+" + c.id + "|" + normUrl(e.to)); if (e.from) known.add("-" + c.id + "|" + normUrl(e.from)); });
  });
  const fresh = [];
  const ts = today + " 00:00:00";
  const camps = new Set([...Object.keys(prev.map), ...urls.keys()]);
  for (const camp of camps) {
    if (camp !== "account" && !names.has(camp)) continue; // campaign removed: its URLs going isn't a landing page change
    const before = new Map(prev.map[camp] || []), now = urls.get(camp) || new Map();
    const campaigns = camp === "account" ? [] : [{ id: camp, name: names.get(camp) || "" }];
    const scope = camp === "account" ? "account-level sitelinks" : "";
    for (const [u, raw] of now) if (!before.has(u) && !known.has("+" + camp + "|" + u))
      fresh.push({ id: "snap:" + today + ":+" + camp + ":" + u, ts, date: today, type: "landing", campaigns, label: "New landing page", from: null, to: raw, unit: "url", scope, user: "", source: "Daily check" });
    for (const [u, raw] of before) if (!now.has(u) && !known.has("-" + camp + "|" + u))
      fresh.push({ id: "snap:" + today + ":-" + camp + ":" + u, ts, date: today, type: "landing", campaigns, label: "Landing page no longer used", from: raw, to: null, unit: "url", scope, user: "", source: "Daily check" });
  }
  return fresh.length ? mergeIntoLog(env, cid, fresh, null) : log;
}

// Fetch the live window, save it, then take the daily landing page snapshot — used by the digest
// cron (and the annotations endpoint) to keep every account's log current.
export async function refreshLog(env, search, cid) {
  const w = liveWindow();
  const fresh = await fetchChanges(search, w.start, w.end);
  let log = await mergeIntoLog(env, cid, fresh, w.start);
  try { log = await snapshotLandingPages(env, search, cid, log); } catch { /* snapshot is best-effort */ }
  return log;
}

export async function readNotes(env, cid) {
  try { return (await env.SESSIONS.get(NOTES_KEY(cid), "json")) || []; } catch { return []; }
}
export async function writeNotes(env, cid, notes) {
  await env.SESSIONS.put(NOTES_KEY(cid), JSON.stringify(notes.slice(-NOTES_CAP)));
}

// Daily-check blips: a page reported "no longer used" and then "new" again for the same campaign
// within 3 days is almost always a failed check, not a real change — hide both halves.
export function dropLandingBlips(events) {
  const DAY = 86400000, gone = new Map(), drop = new Set();
  const key = (e) => ((e.campaigns || [])[0]?.id || "account") + "|" + normUrl(e.from || e.to);
  const daily = (events || []).filter((e) => e.type === "landing" && e.source === "Daily check").sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const e of daily) {
    const k = key(e);
    if (e.from && !e.to) { gone.set(k, e); continue; }
    const g = gone.get(k);
    if (e.to && !e.from && g && Date.parse(e.date) - Date.parse(g.date) <= 3 * DAY) { drop.add(g.id); drop.add(e.id); gone.delete(k); }
  }
  return drop.size ? events.filter((e) => !drop.has(e.id)) : events;
}

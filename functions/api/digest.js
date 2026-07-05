// GET /api/digest — runs the cross-account warning checks and posts a digest to Slack.
//
// Pages Functions can't be cron-triggered, so a small companion Worker pings this
// endpoint on a schedule (see /cron-worker). It runs headless using the refresh token
// saved at login under the fixed KV key `cron:refreshToken`.
//
// Auth:   ?key=<CRON_SECRET>  (required)
// Params: ?dryRun=1  → return the digest as JSON, don't post to Slack (for testing)
//         ?debug=1   → include per-account errors in the JSON response
//
// Checks (enabled campaigns only): suspended account, disapproved ads, limited ads,
// and CPA drift (achieved CPA well under target — the target likely needs adjusting).

import { getAccessToken, adsRequest, json, formatId } from "../../shared/google.js";

const CPA_UNDER = 0.8; // achieved CPA <= target * 0.8 → flag

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // --- shared-secret auth ---
  if (!env.CRON_SECRET || url.searchParams.get("key") !== env.CRON_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }
  const dryRun = url.searchParams.get("dryRun") === "1";
  const debug = url.searchParams.get("debug") === "1";

  // --- headless auth via the token saved at login ---
  const refreshToken = await env.SESSIONS.get("cron:refreshToken");
  if (!refreshToken) {
    return json({ error: "No stored token. Sign in to the dashboard once so the digest can authenticate." }, 400);
  }
  const accessToken = await getAccessToken(env, refreshToken);

  // --- every account this login can reach ---
  const list = await adsRequest(env, accessToken, "customers:listAccessibleCustomers");
  const ids = (list.resourceNames || []).map((rn) => rn.split("/")[1]);

  // User-set monthly budgets (for pacing) + where we are in the month.
  const budgets = await loadBudgets(env);
  const mi = monthInfo();

  const results = await mapLimit(ids, 5, async (id) => {
    try {
      return await auditAccount(env, accessToken, id, budgets, mi);
    } catch (e) {
      return { id, name: formatId(id), issues: [], error: (e && e.message) ? e.message : String(e) };
    }
  });

  const flagged = results.filter((a) => a && a.issues.length);
  const payload = buildSlack(flagged);

  let posted = false, slackError;
  if (!dryRun && flagged.length) {
    if (!env.SLACK_WEBHOOK_URL) {
      slackError = "SLACK_WEBHOOK_URL is not configured";
    } else {
      const res = await fetch(env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      posted = res.ok;
      if (!res.ok) slackError = "Slack responded " + res.status;
    }
  }

  return json({
    ok: true,
    checkedAt: new Date().toISOString(),
    accountsChecked: ids.length,
    flagged: flagged.length,
    posted,
    ...(slackError ? { slackError } : {}),
    ...(dryRun ? { slackPreview: payload } : {}),
    accounts: (debug ? results : flagged).map((a) => ({ id: a.id, name: a.name, issues: a.issues.map((i) => i.text), ...(a.error ? { error: a.error } : {}), ...(debug && a._assetDiag ? { assetDiag: a._assetDiag } : {}) })),
  });
}

// Run the checks for a single account. Returns { id, name, issues:[{level,kind,text}] }.
async function auditAccount(env, accessToken, id, budgets, mi) {
  const search = (query) => adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query });

  const cust = (await search("SELECT customer.descriptive_name, customer.manager, customer.status FROM customer LIMIT 1")).results?.[0]?.customer || {};
  if (cust.manager) return { id, name: cust.descriptiveName || formatId(id), issues: [] }; // MCCs have no campaigns of their own
  const name = cust.descriptiveName || formatId(id);
  const issues = [];

  // 1) Account suspended
  if ((cust.status || "").toUpperCase() === "SUSPENDED") {
    issues.push({ level: 3, kind: "suspended", text: "Account is SUSPENDED" });
  }

  // Enabled campaigns (with Target CPA) — reused by the CPA, pacing and asset checks.
  let campEnabled = [];
  try {
    campEnabled = (await search("SELECT campaign.id, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.status = 'ENABLED'")).results || [];
  } catch { /* leave empty */ }
  const enabledCount = campEnabled.length;

  // 2) Policy — disapproved / limited ads on enabled campaigns
  try {
    const ads = (await search(
      "SELECT ad_group_ad.policy_summary.approval_status, campaign.status, ad_group.status, ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.policy_summary.approval_status != 'APPROVED' AND campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED'"
    )).results || [];
    let disapproved = 0, limited = 0;
    for (const r of ads) {
      const s = r.adGroupAd?.policySummary?.approvalStatus;
      if (s === "DISAPPROVED") disapproved++;
      else if (s === "APPROVED_LIMITED" || s === "AREA_OF_INTEREST_ONLY") limited++;
    }
    if (disapproved) issues.push({ level: 3, kind: "disapproved", text: `${disapproved} disapproved ad${disapproved > 1 ? "s" : ""}` });
    if (limited) issues.push({ level: 2, kind: "limited", text: `${limited} limited ad${limited > 1 ? "s" : ""}` });
  } catch { /* non-fatal: skip policy for this account */ }

  // 3) CPA drift — enabled campaigns whose 30-day CPA is well under target
  try {
    const target = {};
    for (const r of campEnabled) {
      const micros = r.campaign?.targetCpa?.targetCpaMicros ?? r.campaign?.maximizeConversions?.targetCpaMicros;
      if (micros != null) target[r.campaign.id] = Number(micros) / 1e6;
    }
    if (Object.keys(target).length) {
      const metR = await search("SELECT campaign.id, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS");
      const agg = {};
      for (const r of metR.results || []) {
        const cid = r.campaign?.id;
        if (!cid) continue;
        (agg[cid] = agg[cid] || { cost: 0, conv: 0 });
        agg[cid].cost += Number(r.metrics?.costMicros || 0) / 1e6;
        agg[cid].conv += Number(r.metrics?.conversions || 0);
      }
      let drift = 0;
      for (const cid of Object.keys(target)) {
        const a = agg[cid];
        if (!a || a.conv <= 0) continue;
        if (a.cost / a.conv <= target[cid] * CPA_UNDER) drift++;
      }
      if (drift) issues.push({ level: 1, kind: "cpa", text: `${drift} campaign${drift > 1 ? "s" : ""} with CPA well under target` });
    }
  } catch { /* non-fatal */ }

  // 4) Budget pacing — spend vs the user-set monthly budget (matches the Budget
  //    Pacing page: over = red, under = amber; only when a budget is set and the
  //    account has enabled campaigns).
  try {
    const budget = budgets[id] || 0;
    if (budget > 0 && enabledCount > 0) {
      const [spendR, last7R] = await Promise.all([
        search("SELECT metrics.cost_micros FROM campaign WHERE segments.date DURING THIS_MONTH AND campaign.status != 'REMOVED'"),
        search("SELECT metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS AND campaign.status != 'REMOVED'"),
      ]);
      let spend = 0;
      for (const r of spendR.results || []) spend += Number(r.metrics?.costMicros || 0) / 1e6;
      let last7 = 0;
      for (const r of last7R.results || []) last7 += Number(r.metrics?.costMicros || 0) / 1e6;
      const avgDaily = last7 / 7;
      const alert = pacingAlert(spend, budget, avgDaily, mi);
      if (alert) issues.push({ level: alert.level, kind: "pacing", text: alert.text });
    }
  } catch { /* non-fatal */ }

  // 5) Asset gaps — serving campaign-level assets vs thresholds on enabled campaigns
  //    (matches the Assets page: any campaign below a red threshold = red, else amber).
  let assetDiag = { ran: false };
  try {
    if (enabledCount) {
      const camps = {};
      for (const r of campEnabled) camps[r.campaign.id] = { sitelinks: 0, landscape: 0, square: 0, callouts: 0, snippets: 0 };
      const assetR = await search("SELECT campaign.id, campaign.status, campaign_asset.field_type, campaign_asset.status, campaign_asset.primary_status, asset.image_asset.full_size.width_pixels, asset.image_asset.full_size.height_pixels FROM campaign_asset WHERE campaign_asset.status = 'ENABLED' AND campaign_asset.field_type IN ('SITELINK','AD_IMAGE','CALLOUT','STRUCTURED_SNIPPET') AND campaign.status = 'ENABLED'");
      const rows = assetR.results || [];
      const SERVING = new Set(["ELIGIBLE", "LIMITED"]);
      let served = 0, skippedPs = 0;
      for (const r of rows) {
        const c = camps[r.campaign?.id];
        if (!c) continue;
        const ps = r.campaignAsset?.primaryStatus;
        if (ps && !SERVING.has(ps)) { skippedPs++; continue; }
        served++;
        switch (r.campaignAsset?.fieldType) {
          case "SITELINK": c.sitelinks++; break;
          case "AD_IMAGE": {
            const w = Number(r.asset?.imageAsset?.fullSize?.widthPixels) || 0;
            const h = Number(r.asset?.imageAsset?.fullSize?.heightPixels) || 0;
            if (w && h && (w / h) >= 1.3) c.landscape++; else c.square++;
            break;
          }
          case "CALLOUT": c.callouts++; break;
          case "STRUCTURED_SNIPPET": c.snippets++; break;
        }
      }
      const redByType = {}, amberByType = {};
      for (const key of ASSET_KEYS) { redByType[key] = 0; amberByType[key] = 0; }
      let red = 0, amber = 0;
      for (const c of Object.values(camps)) {
        let lvl = 0;
        for (const key of ASSET_KEYS) {
          const L = assetCellLevel(key, c[key]);
          if (L === 2) redByType[key]++; else if (L === 1) amberByType[key]++;
          if (L > lvl) lvl = L;
        }
        if (lvl === 2) red++; else if (lvl === 1) amber++;
      }
      assetDiag = { ran: true, enabledCampaigns: Object.keys(camps).length, assetRows: rows.length, served, skippedPs, red, amber, redByType, amberByType, sampleRow: rows[0] || null, sampleCounts: Object.values(camps).slice(0, 3) };
      // Red = missing entirely (0 of that asset). One bullet per asset type.
      for (const key of ASSET_KEYS) {
        const n = redByType[key];
        if (n) issues.push({ level: 3, kind: "assets", text: `${n} campaign${n > 1 ? "s have" : " has"} 0 ${ASSET_LABELS[key]}` });
      }
      // Amber = present but below the recommended count.
      for (const key of ASSET_KEYS) {
        const n = amberByType[key];
        if (n) issues.push({ level: 2, kind: "assets", text: `${n} campaign${n > 1 ? "s have" : " has"} fewer than ${GREEN_THRESHOLD[key]} ${ASSET_LABELS[key]}` });
      }
    }
  } catch (e) { assetDiag = { ran: false, error: (e && e.message) ? e.message : String(e) }; }

  return { id, name, issues, _assetDiag: assetDiag };
}

// --- shared rule helpers (mirror the dashboard) ---

const ASSET_KEYS = ["sitelinks", "landscape", "square", "callouts", "snippets"];
const ASSET_LABELS = { sitelinks: "Sitelinks", landscape: "Landscape images", square: "Square images", callouts: "Callouts", snippets: "Structured Snippets" };
const GREEN_THRESHOLD = { sitelinks: 8, landscape: 2, square: 5, callouts: 10, snippets: 1 };

function assetCellLevel(key, v) {
  if (key === "sitelinks") return v >= 8 ? 0 : (v >= 1 ? 1 : 2);
  if (key === "landscape") return v >= 2 ? 0 : (v === 1 ? 1 : 2);
  if (key === "square") return v >= 5 ? 0 : (v >= 1 ? 1 : 2);
  if (key === "callouts") return v >= 10 ? 0 : (v >= 1 ? 1 : 2);
  if (key === "snippets") return v >= 1 ? 0 : 2;
  return v === 0 ? 2 : 0;
}

const fmtCurrency0 = (n) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }).format(Math.round(n || 0));

// Budget-pacing alert text — mirrors the dashboard's buildRecommendation exactly, so
// the Slack line reads the same as the account card's recommendation. Returns
// { level, text } for over/under projections, or null when on track.
function pacingAlert(spend, budget, avg7, mi) {
  if (!budget || budget <= 0) return null;
  const remainingDays = Math.max(0, mi.daysInMonth - mi.dayOfMonth);
  const budgetStr = fmtCurrency0(budget);
  const days = (n) => n + (n === 1 ? " day" : " days");
  const projected = spend + avg7 * remainingDays;

  if (remainingDays <= 0) {
    if (spend > budget) return { level: 3, text: `The month is complete. Final spend of ${fmtCurrency0(spend)} came in ${fmtCurrency0(spend - budget)} over the ${budgetStr} monthly budget.` };
    if (spend < budget * 0.95) return { level: 2, text: `The month is complete. Final spend of ${fmtCurrency0(spend)} came in ${fmtCurrency0(budget - spend)} under the ${budgetStr} monthly budget.` };
    return null;
  }

  if (spend >= budget) {
    return { level: 3, text: `Spend has already passed the ${budgetStr} monthly budget by ${fmtCurrency0(spend - budget)} with ${days(remainingDays)} left. Consider pausing or lowering daily spend to limit further overspend.` };
  }

  const requiredDaily = (budget - spend) / remainingDays;
  const band = budget * 0.05;
  const diff = projected - budget;

  if (diff > band) {
    const z = avg7 - requiredDaily;
    return { level: 3, text: `Based on spending for the past 7 days, this account is projected to overspend by ${fmtCurrency0(diff)} versus the client\u2019s ${budgetStr} monthly budget. Reducing average daily spend by ${fmtCurrency0(z)} \u2014 from ${fmtCurrency0(avg7)} to ${fmtCurrency0(requiredDaily)} per day across the remaining ${days(remainingDays)} \u2014 would bring spend in on budget.` };
  }
  if (diff < -band) {
    const z = requiredDaily - avg7;
    const impractical = remainingDays <= 7 && (avg7 <= 0 || requiredDaily > avg7 * 1.5);
    let msg = `Based on spending for the past 7 days, this account is projected to underspend by ${fmtCurrency0(-diff)} versus the client\u2019s ${budgetStr} monthly budget.`;
    if (impractical) {
      msg += ` With only ${days(remainingDays)} left, closing the gap would require a disproportionate jump in daily spend, so no budget change is recommended.`;
    } else {
      msg += ` Increasing average daily spend by ${fmtCurrency0(z)} \u2014 from ${fmtCurrency0(avg7)} to ${fmtCurrency0(requiredDaily)} per day across the remaining ${days(remainingDays)} \u2014 would use the full budget.`;
    }
    return { level: 2, text: msg };
  }
  return null;
}

function monthInfo() {
  const now = new Date();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  return { daysInMonth, dayOfMonth, pace: dayOfMonth / daysInMonth };
}

function money(n) {
  return Math.round(n || 0).toLocaleString("en-GB");
}

async function loadBudgets(env) {
  const budgets = {};
  try {
    const list = await env.SESSIONS.list({ prefix: "budget:" });
    for (const k of list.keys) {
      const v = await env.SESSIONS.get(k.name);
      if (v != null) budgets[k.name.slice("budget:".length)] = Number(v);
    }
  } catch { /* no budgets → pacing simply won't fire */ }
  return budgets;
}

const EMOJI = { 3: "\uD83D\uDD34", 2: "\uD83D\uDFE0", 1: "\uD83D\uDFE1" }; // red / orange / yellow

// Group an account's issues under page-style headings in the Slack message.
const CATEGORY = { suspended: "Account Status", disapproved: "Policy Issues", limited: "Policy Issues", pacing: "Budget Pacing", cpa: "Bidding Strategies", assets: "Assets" };
const CATEGORY_ORDER = ["Account Status", "Policy Issues", "Budget Pacing", "Bidding Strategies", "Assets"];

function buildSlack(flagged) {
  if (!flagged.length) {
    return { text: "\u2705 AdLytics daily check: all accounts look healthy." };
  }
  const top = (a) => Math.max(...a.issues.map((i) => i.level));
  flagged.sort((a, b) => top(b) - top(a));
  const header = `*AdLytics \u2014 ${flagged.length} account${flagged.length > 1 ? "s" : ""} need attention*`;
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: header } }];
  const textParts = [header];
  for (const a of flagged) {
    const byCat = {};
    for (const i of a.issues) { const cat = CATEGORY[i.kind] || "Other"; (byCat[cat] = byCat[cat] || []).push(i); }
    const catBlocks = [];
    for (const cat of CATEGORY_ORDER) {
      const items = byCat[cat];
      if (!items || !items.length) continue;
      items.sort((x, y) => y.level - x.level);
      const catLevel = Math.max(...items.map((i) => i.level));
      const bullets = items.map((i) => `\u2022 ${i.text}`).join("\n");
      catBlocks.push(`${EMOJI[catLevel]} *${cat}:*\n${bullets}`);
    }
    // Blank line after the account name and between categories.
    const section = `*${a.name}*\n\n${catBlocks.join("\n\n")}`;
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: section } });
    textParts.push(section);
  }
  return { text: textParts.join("\n\n"), blocks };
}

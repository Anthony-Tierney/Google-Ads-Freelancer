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

  const results = await mapLimit(ids, 5, async (id) => {
    try {
      return await auditAccount(env, accessToken, id);
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
    accounts: (debug ? results : flagged).map((a) => ({ id: a.id, name: a.name, issues: a.issues.map((i) => i.text), ...(a.error ? { error: a.error } : {}) })),
  });
}

// Run the checks for a single account. Returns { id, name, issues:[{level,kind,text}] }.
async function auditAccount(env, accessToken, id) {
  const search = (query) => adsRequest(env, accessToken, `customers/${id}/googleAds:search`, { query });

  const cust = (await search("SELECT customer.descriptive_name, customer.manager, customer.status FROM customer LIMIT 1")).results?.[0]?.customer || {};
  if (cust.manager) return { id, name: cust.descriptiveName || formatId(id), issues: [] }; // MCCs have no campaigns of their own
  const name = cust.descriptiveName || formatId(id);
  const issues = [];

  // 1) Account suspended
  if ((cust.status || "").toUpperCase() === "SUSPENDED") {
    issues.push({ level: 3, kind: "suspended", text: "Account is SUSPENDED" });
  }

  // 2) Policy — disapproved / limited ads on enabled campaigns
  try {
    const ads = (await search(
      "SELECT ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE ad_group_ad.policy_summary.approval_status != 'APPROVED' AND campaign.status = 'ENABLED' AND ad_group_ad.status != 'REMOVED'"
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
    const [campR, metR] = await Promise.all([
      search("SELECT campaign.id, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.status = 'ENABLED'"),
      search("SELECT campaign.id, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS"),
    ]);
    const target = {};
    for (const r of campR.results || []) {
      const micros = r.campaign?.targetCpa?.targetCpaMicros ?? r.campaign?.maximizeConversions?.targetCpaMicros;
      if (micros != null) target[r.campaign.id] = Number(micros) / 1e6;
    }
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
  } catch { /* non-fatal */ }

  return { id, name, issues };
}

const EMOJI = { 3: "\uD83D\uDD34", 2: "\uD83D\uDFE0", 1: "\uD83D\uDFE1" }; // red / orange / yellow

function buildSlack(flagged) {
  if (!flagged.length) {
    return { text: "\u2705 AdLytics daily check: all accounts look healthy." };
  }
  const top = (a) => Math.max(...a.issues.map((i) => i.level));
  flagged.sort((a, b) => top(b) - top(a));
  const lines = flagged.map((a) => {
    const parts = a.issues.slice().sort((x, y) => y.level - x.level).map((i) => i.text).join(" \u00b7 ");
    return `${EMOJI[top(a)]} *${a.name}* \u2014 ${parts}`;
  });
  const header = `*AdLytics \u2014 ${flagged.length} account${flagged.length > 1 ? "s" : ""} need attention*`;
  return {
    text: header + "\n" + lines.join("\n"),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: header } },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      { type: "context", elements: [{ type: "mrkdwn", text: "\uD83D\uDD34 disapproved / suspended \u00b7 \uD83D\uDFE0 limited \u00b7 \uD83D\uDFE1 CPA drift" }] },
    ],
  };
}

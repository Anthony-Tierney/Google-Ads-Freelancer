// GET /api/cannibalization?customerId=<id>&dateRange=<gaql date clause>
// Flags search terms within ONE account that triggered 2+ campaigns over the range, and
// checks each competing campaign against what's in place NOW, so fixes are recognised:
//   • campaign-level negative keywords
//   • shared negative keyword lists attached to the campaign
//   • ad group negatives (only if they cover every ad group the term served from)
//   • paused/removed campaigns or ad groups
// Negative matching follows Google's rules (no close variants):
//   EXACT = whole term equals keyword · PHRASE = keyword words appear in order · BROAD = all words present.
//   { terms: [{ term, campaignCount, activeCount, resolution: "open"|"partial"|"resolved",
//               impressions, clicks, cost, conversions,
//               campaigns: [{ name, impressions, clicks, cost, conversions, active, reason }] }],
//     _errors? }

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);

function negMatches(neg, term) {
  const t = words(term), k = words(neg.text);
  if (!k.length) return false;
  if (neg.matchType === "EXACT") return t.join(" ") === k.join(" ");
  if (neg.matchType === "PHRASE") {
    for (let i = 0; i + k.length <= t.length; i++) {
      let ok = true;
      for (let j = 0; j < k.length; j++) if (t[i + j] !== k[j]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }
  const set = new Set(t); // BROAD
  return k.every((w) => set.has(w));
}
const firstMatch = (list, term) => (list || []).find((n) => negMatches(n, term));
const mtLabel = (m) => (m === "EXACT" ? "exact" : m === "PHRASE" ? "phrase" : "broad");

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  if (!customerId || customerId === "ALL") return json({ error: "Select a single account" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  const drParam = url.searchParams.get("dateRange") || "LAST_30_DAYS";
  const drFixed = drParam.replace(/'(\d{4})(\d{2})(\d{2})'/g, "'$1-$2-$3'");
  const dateClause = /segments\.date/i.test(drFixed) ? drFixed : "segments.date DURING " + drFixed;

  const accessToken = await getAccessToken(env, refreshToken);
  const search = async (query) => {
    const out = [];
    let pageToken, pages = 0;
    do {
      const r = await adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, pageToken ? { query, pageToken } : { query });
      out.push(...(r.results || []));
      pageToken = r.nextPageToken;
    } while (pageToken && ++pages < 50);
    return out;
  };
  const errors = [];
  const safe = async (label, query) => {
    try { return await search(query); }
    catch (e) { errors.push(label + ": " + String(e && e.message ? e.message : e).slice(0, 160)); return []; }
  };

  // 1) Search terms (historical) — with ad group + current statuses.
  let stRows;
  try {
    stRows = await search(`SELECT search_term_view.search_term, campaign.id, campaign.name, campaign.status, ad_group.id, ad_group.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE ${dateClause}`);
  } catch (e) {
    return json({ terms: [], error: "Could not load search terms", detail: String(e && e.message ? e.message : e).slice(0, 200) }, 200);
  }

  // 2) Current negatives — each source independent so one failure doesn't sink the page.
  const [campNegRows, agNegRows, linkRows, sharedRows] = await Promise.all([
    safe("campaign negatives", "SELECT campaign.id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.status != 'REMOVED'"),
    safe("ad group negatives", "SELECT ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.negative = TRUE AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'"),
    safe("shared list links", "SELECT campaign.id, shared_set.id, shared_set.type, campaign_shared_set.status FROM campaign_shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND campaign_shared_set.status = 'ENABLED'"),
    safe("shared list keywords", "SELECT shared_set.id, shared_set.name, shared_set.type, shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion WHERE shared_set.type = 'NEGATIVE_KEYWORDS'"),
  ]);

  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  const campNeg = new Map(), agNeg = new Map(), campSets = new Map(), setNeg = new Map(), setName = new Map();
  campNegRows.forEach((r) => { const kw = r.campaignCriterion?.keyword; if (kw?.text) push(campNeg, String(r.campaign?.id), { text: kw.text, matchType: kw.matchType }); });
  agNegRows.forEach((r) => { const kw = r.adGroupCriterion?.keyword; if (kw?.text) push(agNeg, String(r.adGroup?.id), { text: kw.text, matchType: kw.matchType }); });
  linkRows.forEach((r) => push(campSets, String(r.campaign?.id), String(r.sharedSet?.id)));
  sharedRows.forEach((r) => {
    const id = String(r.sharedSet?.id), kw = r.sharedCriterion?.keyword;
    if (r.sharedSet?.name) setName.set(id, r.sharedSet.name);
    if (kw?.text) push(setNeg, id, { text: kw.text, matchType: kw.matchType });
  });

  // 3) Aggregate term -> campaign, remembering which ad groups each term served from.
  const byTerm = new Map();
  for (const r of stRows) {
    const term = r.searchTermView?.searchTerm, cid = String(r.campaign?.id || "");
    if (!term || !cid) continue;
    const m = r.metrics || {};
    let camps = byTerm.get(term);
    if (!camps) { camps = new Map(); byTerm.set(term, camps); }
    let c = camps.get(cid);
    if (!c) { c = { id: cid, name: r.campaign?.name || "", status: r.campaign?.status || "", adGroups: new Map(), impressions: 0, clicks: 0, cost: 0, conversions: 0 }; camps.set(cid, c); }
    if (r.adGroup?.id) c.adGroups.set(String(r.adGroup.id), r.adGroup.status || "");
    c.impressions += Number(m.impressions) || 0;
    c.clicks += Number(m.clicks) || 0;
    c.cost += (Number(m.costMicros) || 0) / 1e6;
    c.conversions += Number(m.conversions) || 0;
  }

  // Can this campaign still show for this term today? Returns null if yes, else the reason.
  function blockedReason(c, term) {
    if (c.status && c.status !== "ENABLED") return c.status === "REMOVED" ? "Campaign removed" : "Campaign paused";
    const cn = firstMatch(campNeg.get(c.id), term);
    if (cn) return `Campaign negative "${cn.text}" (${mtLabel(cn.matchType)})`;
    for (const sid of campSets.get(c.id) || []) {
      const sn = firstMatch(setNeg.get(sid), term);
      if (sn) return `Negative list "${setName.get(sid) || "Shared list"}": "${sn.text}" (${mtLabel(sn.matchType)})`;
    }
    if (c.adGroups.size) {
      let covered = 0, viaNeg = 0;
      for (const [agId, agStatus] of c.adGroups) {
        if (agStatus && agStatus !== "ENABLED") { covered++; continue; }
        if (firstMatch(agNeg.get(agId), term)) { covered++; viaNeg++; continue; }
      }
      if (covered === c.adGroups.size) return viaNeg ? "Ad group negatives" : "Ad groups paused";
    }
    return null;
  }

  const terms = [];
  for (const [term, camps] of byTerm) {
    if (camps.size < 2) continue;
    const campaigns = [...camps.values()].sort((a, b) => b.impressions - a.impressions).map((c) => {
      const reason = blockedReason(c, term);
      return { name: c.name, impressions: c.impressions, clicks: c.clicks, cost: c.cost, conversions: c.conversions, active: !reason, reason: reason || "" };
    });
    const activeCount = campaigns.filter((c) => c.active).length;
    const resolution = activeCount <= 1 ? "resolved" : activeCount < campaigns.length ? "partial" : "open";
    const sum = (k) => campaigns.reduce((a, c) => a + c[k], 0);
    terms.push({ term, campaignCount: campaigns.length, activeCount, resolution, impressions: sum("impressions"), clicks: sum("clicks"), cost: sum("cost"), conversions: sum("conversions"), campaigns });
  }
  terms.sort((a, b) => b.impressions - a.impressions);

  const payload = { terms };
  if (errors.length) payload._errors = errors;
  return json(payload);
}

// shared/negatives.js — "would this search term be blocked by the account's current negatives?"
// Same rules Google uses for negatives (no close variants):
//   EXACT  = whole term equals the keyword
//   PHRASE = the keyword's words appear together, in order
//   BROAD  = every keyword word appears somewhere in the term

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);

export function negMatches(neg, term) {
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
export const firstMatch = (list, term) => (list || []).find((n) => negMatches(n, term));
export const mtLabel = (m) => (m === "EXACT" ? "exact" : m === "PHRASE" ? "phrase" : "broad");

// Load every current negative in the account: campaign, ad group and shared negative lists.
// `search(query)` must return an array of result rows. Each source is independent, so one
// failing doesn't hide the others (failures are listed in `errors`).
export async function loadNegatives(search) {
  const errors = [];
  const safe = async (label, q) => { try { return await search(q); } catch (e) { errors.push(label); return []; } };
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

  // Which current negative (if any) stops `term` showing in this campaign / ad group?
  function negativeFor(term, campaignId, adGroupId) {
    const cn = firstMatch(campNeg.get(String(campaignId)), term);
    if (cn) return `Campaign negative "${cn.text}" (${mtLabel(cn.matchType)})`;
    for (const sid of campSets.get(String(campaignId)) || []) {
      const sn = firstMatch(setNeg.get(sid), term);
      if (sn) return `Negative list "${setName.get(sid) || "Shared list"}": "${sn.text}" (${mtLabel(sn.matchType)})`;
    }
    const an = firstMatch(agNeg.get(String(adGroupId)), term);
    if (an) return `Ad group negative "${an.text}" (${mtLabel(an.matchType)})`;
    return "";
  }
  return { negativeFor, errors };
}

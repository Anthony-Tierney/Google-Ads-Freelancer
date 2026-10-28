// GET /api/structure?customerId=<id>
// Account structure for the Account Structure page: campaigns and the ad groups inside them
// (removed items excluded). No metrics — this describes how the account is built.
//   { campaigns: [{ id, name, status: "Enabled"|"Paused"|"Ended", channelType,
//                   adGroups: [{ id, name, status: "Enabled"|"Paused" }] }], warning? }

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";

const STATUS_LABEL = { ENABLED: "Enabled", PAUSED: "Paused" };

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId || customerId === "ALL") return json({ error: "Select a single account" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  const accessToken = await getAccessToken(env, refreshToken);
  const search = async (query) => {
    const out = [];
    let pageToken, pages = 0;
    do {
      const r = await adsRequest(env, accessToken, `customers/${cleanId}/googleAds:search`, pageToken ? { query, pageToken } : { query });
      out.push(...(r.results || []));
      pageToken = r.nextPageToken;
    } while (pageToken && ++pages < 20);
    return out;
  };

  let campRows;
  try {
    campRows = await search(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.status != 'REMOVED'`);
  } catch (e) {
    return json({ error: "Could not load campaigns: " + String(e?.message || e).slice(0, 200) }, 500);
  }

  const warnings = [];
  // Ended = enabled campaign past its end date (only visible as serving_status). Isolated so a
  // failure just leaves those campaigns labelled "Enabled".
  const ended = new Set();
  try {
    (await search(`SELECT campaign.id, campaign.serving_status FROM campaign WHERE campaign.status = 'ENABLED'`))
      .forEach((r) => { if (r.campaign?.servingStatus === "ENDED") ended.add(String(r.campaign.id)); });
  } catch (e) { warnings.push("Couldn't check which campaigns have ended."); }

  let agRows = [];
  try {
    agRows = await search(`SELECT campaign.id, campaign.status, ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`);
  } catch (e) { warnings.push("Couldn't load ad groups: " + String(e?.message || e).slice(0, 160)); }

  const byId = new Map();
  campRows.forEach((r) => {
    const c = r.campaign || {}, id = String(c.id);
    const status = c.status === "ENABLED" && ended.has(id) ? "Ended" : (STATUS_LABEL[c.status] || "");
    byId.set(id, { id, name: c.name || "", status, channelType: c.advertisingChannelType || "", adGroups: [] });
  });
  agRows.forEach((r) => {
    const camp = byId.get(String(r.campaign?.id));
    if (camp) camp.adGroups.push({ id: String(r.adGroup?.id || ""), name: r.adGroup?.name || "", status: STATUS_LABEL[r.adGroup?.status] || "" });
  });
  const campaigns = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  campaigns.forEach((c) => c.adGroups.sort((a, b) => a.name.localeCompare(b.name)));

  const payload = { campaigns };
  if (warnings.length) payload.warning = warnings.join(" ");
  return json(payload);
}

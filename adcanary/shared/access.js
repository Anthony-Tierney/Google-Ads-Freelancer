// shared/access.js — "can this signed-in person use this Google Ads account?"
//
// Anything AdCanary stores per account (change log, notes, monthly budgets) must only be read or
// changed by people Google says can access that account. The authority is the same call that
// builds the account picker (customers:listAccessibleCustomers), made with the person's own login.
// The list is cached for an hour, keyed by a one-way hash of their token (the token itself is
// never used as a key), so normal page loads don't hit Google every time.

import { getAccessToken, adsRequest } from "./google.js";

const TTL = 60 * 60; // 1 hour

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// IDs (digits only) of every account this login can reach.
export async function accessibleIds(env, refreshToken) {
  const key = "acl:v1:" + (await sha256(refreshToken)).slice(0, 40);
  try { const hit = await env.SESSIONS.get(key, "json"); if (Array.isArray(hit)) return hit; } catch {}
  const accessToken = await getAccessToken(env, refreshToken);
  const list = await adsRequest(env, accessToken, "customers:listAccessibleCustomers");
  const ids = (list.resourceNames || []).map((rn) => String(rn).split("/")[1]).filter(Boolean);
  try { await env.SESSIONS.put(key, JSON.stringify(ids), { expirationTtl: TTL }); } catch {}
  return ids;
}

export async function canAccess(env, refreshToken, customerId) {
  const cid = String(customerId || "").replace(/-/g, "");
  if (!/^\d{6,12}$/.test(cid)) return false;
  try { return (await accessibleIds(env, refreshToken)).includes(cid); } catch { return false; }
}

// GET /api/session — lightweight check that the session cookie maps to a live
// session in KV. Does NOT call the Google Ads API, so a browser refresh can
// confirm the user is still signed in cheaply and restore cached data without
// re-fetching account data from Google.

import { getRefreshToken } from "../../shared/google.js";

export async function onRequestGet(context) {
  const refreshToken = await getRefreshToken(context);
  return new Response(JSON.stringify({ ok: !!refreshToken }), {
    status: refreshToken ? 200 : 401,
    headers: { "Content-Type": "application/json" },
  });
}

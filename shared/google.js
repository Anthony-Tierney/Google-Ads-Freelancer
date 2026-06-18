// Shared helpers used by the API functions.
// Lives at the repo root (outside /functions) so it is imported, not routed.

const ADS_API_VERSION = "v24";
const ADS_BASE = `https://googleads.googleapis.com/${ADS_API_VERSION}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Swap a stored refresh token for a fresh, short-lived access token.
export async function getAccessToken(env, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

// Read the session cookie and look up its refresh token in KV.
// Returns null if the user isn't signed in.
export async function getRefreshToken(context) {
  const { request, env } = context;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  return await env.SESSIONS.get(`session:${match[1]}`);
}

// Make an authenticated Google Ads API call. GET if no body, POST if a body.
export async function adsRequest(env, accessToken, path, body, loginCustomerId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": env.GOOGLE_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const res = await fetch(`${ADS_BASE}/${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ads API ${res.status}: ${text}`);
  }
  return res.json();
}

// Small helper for JSON responses.
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Format a bare 10-digit customer ID as 123-456-7890.
export function formatId(id) {
  return id.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
}

// Shared helpers used by the API functions.
// Lives at the repo root (outside /functions) so it is imported, not routed.

const ADS_API_VERSION = "v24";
const ADS_BASE = `https://googleads.googleapis.com/${ADS_API_VERSION}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Swap a stored refresh token for a fresh, short-lived access token.
export async function getAccessToken(env, refreshToken) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
        }),
      });
    } catch (e) {
      if (attempt < 3) { await sleep(backoffMs(attempt, null)); continue; }
      throw new Error(`Token refresh network error: ${e && e.message ? e.message : e}`);
    }
    if (res.ok) return (await res.json()).access_token;
    // Only 5xx are worth retrying; 4xx means the refresh token/credentials are bad.
    if (res.status >= 500 && attempt < 3) { await sleep(backoffMs(attempt, res.headers.get("Retry-After"))); continue; }
    throw new Error(`Token refresh failed: ${res.status}`);
  }
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

// HTTP statuses worth retrying (rate limit + transient server errors).
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Backoff delay in ms. Honours a Retry-After header when present, else
// exponential (≈0.3s, 0.6s, 1.2s…) with jitter, capped at 8s.
function backoffMs(attempt, retryAfter) {
  if (retryAfter != null) {
    const s = Number(retryAfter);
    if (!Number.isNaN(s) && s >= 0) return Math.min(s * 1000, 8000);
  }
  return Math.min(300 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 200);
}

// Make an authenticated Google Ads API call. GET if no body, POST if a body.
// Retries transient failures (429/5xx + network errors) with exponential backoff.
// `opts.maxAttempts` defaults to 4 (1 try + 3 retries).
export async function adsRequest(env, accessToken, path, body, loginCustomerId, opts = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": env.GOOGLE_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const maxAttempts = opts.maxAttempts || 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(`${ADS_BASE}/${path}`, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Network/transport failure — retry if attempts remain.
      lastErr = e;
      if (attempt < maxAttempts) { await sleep(backoffMs(attempt, null)); continue; }
      throw new Error(`Ads API network error after ${attempt} attempt(s): ${e && e.message ? e.message : e}`);
    }

    if (res.ok) return res.json();

    const text = await res.text();
    if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
      lastErr = new Error(`Ads API ${res.status}: ${text}`);
      await sleep(backoffMs(attempt, res.headers.get("Retry-After")));
      continue;
    }
    throw new Error(`Ads API ${res.status}: ${text}`);
  }
  throw lastErr || new Error("Ads API request failed");
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

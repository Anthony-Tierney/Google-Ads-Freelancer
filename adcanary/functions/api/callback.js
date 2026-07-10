// GET /api/callback  — Google redirects here after the user consents.
// Exchanges the one-time code for tokens, stores the refresh token in KV,
// and sets a session cookie so later requests know who the user is.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Verify the state matches the cookie we set in /api/auth.
  const cookie = request.headers.get("Cookie") || "";
  const stateCookie = cookie.match(/(?:^|;\s*)oauth_state=([^;]+)/);
  if (!code || !state || !stateCookie || stateCookie[1] !== state) {
    return new Response("Invalid OAuth state", { status: 400 });
  }

  // Exchange the authorization code for tokens (needs the client secret).
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.OAUTH_REDIRECT_URI,
    }),
  });
  if (!tokenRes.ok) {
    return new Response("Token exchange failed", { status: 502 });
  }
  const tokens = await tokenRes.json();

  // Store the refresh token against a new session id (30-day expiry).
  const sessionId = crypto.randomUUID();
  const ttl = 60 * 60 * 24 * 30;
  await env.SESSIONS.put(`session:${sessionId}`, tokens.refresh_token, {
    expirationTtl: ttl,
  });

  // Also keep a copy under a fixed key (no expiry) so the scheduled Slack digest
  // can authenticate headless. Google only returns a refresh_token on first consent,
  // so only overwrite when we actually got one.
  if (tokens.refresh_token) {
    await env.SESSIONS.put("cron:refreshToken", tokens.refresh_token);
  }

  // Drop the session cookie and send the user back to the app.
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/dashboard",
      "Set-Cookie": `session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttl}`,
    },
  });
}

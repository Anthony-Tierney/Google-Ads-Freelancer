// GET /api/auth  — your Login button links here.
// Builds the Google consent URL and redirects the user to sign in.

export async function onRequestGet(context) {
  const { env } = context;

  // A random state value guards against CSRF on the round-trip.
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/adwords",
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // ensure a refresh token is returned
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}

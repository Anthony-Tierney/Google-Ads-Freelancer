// GET /api/logout — clears the session cookie and its KV entry, then redirects home.

export async function onRequestGet(context) {
  const { request, env } = context;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);

  if (match) {
    try { await env.SESSIONS.delete(`session:${match[1]}`); } catch {}
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    },
  });
}

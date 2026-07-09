// Tiny scheduled Worker whose only job is to ping the AdLytics digest endpoint on a
// schedule. (Cloudflare Pages Functions can't be cron-triggered, so the schedule lives
// here in a Worker and the actual work happens in /api/digest on the Pages app.)
//
// Config (wrangler.toml):
//   vars    DIGEST_URL   e.g. https://anthonytierney.co.uk/api/digest
//   secret  CRON_SECRET  must match the CRON_SECRET set on the Pages project
//   crons   the schedule, e.g. ["0 8 * * *"] for 08:00 UTC daily

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDigest(env));
  },

  // Manual trigger for testing: GET https://<worker-url>/?key=<CRON_SECRET>
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.CRON_SECRET || url.searchParams.get("key") !== env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = await runDigest(env, url.searchParams.get("dryRun") === "1");
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  },
};

async function runDigest(env, dryRun) {
  const u = new URL(env.DIGEST_URL);
  u.searchParams.set("key", env.CRON_SECRET);
  if (dryRun) u.searchParams.set("dryRun", "1");
  const res = await fetch(u.toString(), { headers: { "User-Agent": "AdLytics-Cron/1.0" } });
  return await res.text();
}

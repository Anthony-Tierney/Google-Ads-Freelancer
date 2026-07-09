// /api/budgets
//   GET  -> { budgets: { [customerId]: amount } }   (all saved monthly budgets)
//   POST -> body { customerId, amount }              (save; amount null/0 clears it)
//
// Budgets are stored in the SESSIONS KV namespace under keys "budget:{customerId}",
// with no expiry, so they persist across devices and logins.

import { getRefreshToken, json } from "../../shared/google.js";

const PREFIX = "budget:";

export async function onRequestGet(context) {
  const { env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const budgets = {};
  try {
    const list = await env.SESSIONS.list({ prefix: PREFIX });
    for (const key of list.keys) {
      const value = await env.SESSIONS.get(key.name);
      if (value != null) budgets[key.name.slice(PREFIX.length)] = Number(value);
    }
  } catch (e) {
    return json({ error: (e && e.message) ? e.message : "Could not read budgets" }, 500);
  }

  return json({ budgets });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const customerId = String(body.customerId || "").replace(/-/g, "");
  if (!customerId) return json({ error: "Missing customerId" }, 400);

  const amount = body.amount;
  try {
    if (amount == null || amount === "" || Number(amount) <= 0) {
      await env.SESSIONS.delete(`${PREFIX}${customerId}`);
      return json({ ok: true, customerId, amount: null });
    }
    await env.SESSIONS.put(`${PREFIX}${customerId}`, String(Number(amount)));
    return json({ ok: true, customerId, amount: Number(amount) });
  } catch (e) {
    return json({ error: (e && e.message) ? e.message : "Could not save budget" }, 500);
  }
}

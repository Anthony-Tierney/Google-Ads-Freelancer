// GET /api/accounts  — returns the Google Ads accounts this login can access,
// so the frontend can show a picker. Each entry has id, formatted id, and name.

import {
  getRefreshToken,
  getAccessToken,
  adsRequest,
  json,
  formatId,
} from "../../shared/google.js";

export async function onRequestGet(context) {
  const { env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const accessToken = await getAccessToken(env, refreshToken);

  // The IDs of every account the signed-in user can reach.
  const list = await adsRequest(
    env,
    accessToken,
    "customers:listAccessibleCustomers"
  );
  const resourceNames = list.resourceNames || [];

  // Best-effort: look up each account's name so the picker is readable, and skip
  // manager (MCC) accounts, which have no campaigns or metrics of their own.
  const accounts = (await Promise.all(
    resourceNames.map(async (rn) => {
      const id = rn.split("/")[1];
      try {
        const result = await adsRequest(
          env,
          accessToken,
          `customers/${id}/googleAds:search`,
          { query: "SELECT customer.descriptive_name, customer.manager FROM customer LIMIT 1" }
        );
        const cust = result.results?.[0]?.customer || {};
        if (cust.manager) return null; // hide manager accounts entirely
        return { id, formatted: formatId(id), name: cust.descriptiveName || null };
      } catch {
        return { id, formatted: formatId(id), name: null };
      }
    })
  )).filter(Boolean);

  return json({ accounts });
}

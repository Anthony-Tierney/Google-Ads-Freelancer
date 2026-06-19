// GET /api/audit?customerId=1234567890
// Returns a policy/health summary for one account:
//   { accountStatus, disapproved, limited, issues: [{campaign, adGroup, status}] }

import {
  getRefreshToken,
  getAccessToken,
  adsRequest,
  json,
} from "../../shared/google.js";

export async function onRequestGet(context) {
  const { request, env } = context;

  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);

  const customerId = new URL(request.url).searchParams.get("customerId");
  if (!customerId) return json({ error: "Missing customerId" }, 400);
  const cleanId = customerId.replace(/-/g, "");

  const accessToken = await getAccessToken(env, refreshToken);

  // 1) Account status (ENABLED / SUSPENDED / CANCELED / CLOSED)
  let accountStatus = "UNKNOWN";
  try {
    const cust = await adsRequest(
      env,
      accessToken,
      `customers/${cleanId}/googleAds:search`,
      { query: "SELECT customer.status FROM customer LIMIT 1" }
    );
    accountStatus = cust.results?.[0]?.customer?.status || "UNKNOWN";
  } catch (e) {
    // non-fatal; continue to ad policy check
  }

  // 2) Non-approved ads in enabled campaigns
  let disapproved = 0;
  let limited = 0;
  const issues = [];

  try {
    const ads = await adsRequest(
      env,
      accessToken,
      `customers/${cleanId}/googleAds:search`,
      {
        query: `
          SELECT
            campaign.name,
            ad_group.name,
            ad_group_ad.policy_summary.approval_status,
            ad_group_ad.policy_summary.review_status,
            ad_group_ad.ad.id
          FROM ad_group_ad
          WHERE ad_group_ad.policy_summary.approval_status != 'APPROVED'
            AND campaign.status = 'ENABLED'
            AND ad_group_ad.status = 'ENABLED'
          LIMIT 200`,
      }
    );

    (ads.results || []).forEach((r) => {
      const status = r.adGroupAd?.policySummary?.approvalStatus;
      if (status === "DISAPPROVED") disapproved++;
      else if (status === "APPROVED_LIMITED" || status === "AREA_OF_INTEREST_ONLY") limited++;

      if (issues.length < 25) {
        issues.push({
          campaign: r.campaign?.name || null,
          adGroup: r.adGroup?.name || null,
          status: status || "UNKNOWN",
        });
      }
    });
  } catch (e) {
    return json({
      accountStatus,
      disapproved,
      limited,
      issues,
      error: (e && e.message) ? e.message : "Policy query failed",
    });
  }

  return json({ accountStatus, disapproved, limited, issues });
}

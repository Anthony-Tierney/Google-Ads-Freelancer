// /api/annotations — graph annotations for the Performance Overview page.
//
// GET    ?customerId=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
//        → { changes: [...], notes: [...], historyFrom }
//          changes = budget / bidding / status changes (see shared/changes.js), from the saved
//          log plus Google's live 30-day change history (anything new is saved to the log).
//          historyFrom = earliest date change history is available for this account.
// POST   { customerId, date, text, campaign? }  → { note }       add a manual note
// DELETE ?customerId=<id>&id=<noteId>           → { ok: true }   remove a note
// Every action first checks the signed-in person can access that Google Ads account (403 if not).

import { getRefreshToken, getAccessToken, adsRequest, json } from "../../shared/google.js";
import { fetchChanges, liveWindow, mergeIntoLog, readLog, readNotes, writeNotes, adsErrorReason, snapshotLandingPages } from "../../shared/changes.js";
import { canAccess } from "../../shared/access.js";

const NO_ACCESS = () => json({ error: "You don't have access to this Google Ads account" }, 403);

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const cleanCid = (s) => String(s || "").replace(/-/g, "");

export async function onRequestGet(context) {
  const { request, env } = context;
  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);
  const url = new URL(request.url);
  const cid = cleanCid(url.searchParams.get("customerId"));
  const from = url.searchParams.get("from"), to = url.searchParams.get("to");
  if (!/^\d{6,12}$/.test(cid)) return json({ error: "Select a single account" }, 400);
  if (!isDate(from) || !isDate(to)) return json({ error: "Missing from/to dates" }, 400);
  if (!(await canAccess(env, refreshToken, cid))) return NO_ACCESS();

  let log = await readLog(env, cid);
  let liveError;
  const w = liveWindow();
  if (to >= w.start) {
    // The range overlaps Google's live window: pull it and save anything new.
    try {
      const accessToken = await getAccessToken(env, refreshToken);
      const search = async (query) => {
        const out = []; let pageToken, pages = 0;
        do {
          const r = await adsRequest(env, accessToken, `customers/${cid}/googleAds:search`, pageToken ? { query, pageToken } : { query });
          out.push(...(r.results || [])); pageToken = r.nextPageToken;
        } while (pageToken && ++pages < 10);
        return out;
      };
      const fresh = await fetchChanges(search, w.start, w.end);
      log = await mergeIntoLog(env, cid, fresh, w.start);
      // Once a day per account: compare live landing pages with yesterday's (catches Performance Max etc.).
      try { log = await snapshotLandingPages(env, search, cid, log); } catch { /* best-effort */ }
    } catch (e) { liveError = adsErrorReason(e).slice(0, 300); }
  }
  const inRange = (d) => d >= from && d <= to;
  const notes = (await readNotes(env, cid)).filter((n) => inRange(n.date));
  const payload = { changes: log.events.filter((e) => inRange(e.date)), notes, historyFrom: log.since || w.start };
  if (liveError) payload.warning = "Couldn't load the latest changes from Google: " + liveError;
  return json(payload);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);
  let body; try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const cid = cleanCid(body.customerId);
  const text = String(body.text || "").trim().slice(0, 300);
  const campaign = String(body.campaign || "").slice(0, 200);
  const campaignId = /^\d{1,15}$/.test(String(body.campaignId || "")) ? String(body.campaignId) : "";
  if (!/^\d{6,12}$/.test(cid)) return json({ error: "Select a single account" }, 400);
  if (!isDate(body.date)) return json({ error: "Pick a date" }, 400);
  if (!text) return json({ error: "Write a note" }, 400);
  if (!(await canAccess(env, refreshToken, cid))) return NO_ACCESS();
  const note = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), date: body.date, text, campaign, campaignId, createdAt: new Date().toISOString() };
  const notes = await readNotes(env, cid);
  notes.push(note);
  try { await writeNotes(env, cid, notes); } catch { return json({ error: "Couldn't save the note" }, 500); }
  return json({ note });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const refreshToken = await getRefreshToken(context);
  if (!refreshToken) return json({ error: "Not signed in" }, 401);
  const url = new URL(request.url);
  const cid = cleanCid(url.searchParams.get("customerId")), id = url.searchParams.get("id");
  if (!/^\d{6,12}$/.test(cid) || !id) return json({ error: "Bad request" }, 400);
  if (!(await canAccess(env, refreshToken, cid))) return NO_ACCESS();
  const notes = await readNotes(env, cid);
  const left = notes.filter((n) => n.id !== id);
  if (left.length === notes.length) return json({ error: "Note not found" }, 404);
  try { await writeNotes(env, cid, left); } catch { return json({ error: "Couldn't delete the note" }, 500); }
  return json({ ok: true });
}

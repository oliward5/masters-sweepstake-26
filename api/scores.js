// This file runs on Vercel's servers (not in the browser).
// It fetches the golf leaderboard from ESPN's public API and passes it back
// to the webpage, avoiding browser security restrictions.
//
// EVENT SELECTION: the scoreboard feed can hold several concurrent events (each
// major runs alongside an opposite-field tour event), so we pick ONE and return it
// alone in events[]: the organiser's configured event name if it matches, otherwise
// this week's MAJOR — via ESPN's own tournament.major flag, with a name-pattern
// fallback if that API is down. No major and no override => events[] is empty and
// the front-end shows a "waiting for the next major" notice. This is what makes the
// app self-configuring for all four majors. Kept in sync with api/claim.js.
//
// It ALSO snapshots each golfer's round scores into Redis on a throttle. This is the
// fix for the missed-cut rule: once a tournament finalises, ESPN deletes cut players
// from its feed entirely, so the app could no longer show "round-2 score + 3". By
// capturing round totals while players are still in the feed (and never deleting
// them), the front-end can keep applying the +3 penalty after they disappear.

const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SNAPSHOT_THROTTLE_MS = 110000; // ~one upstream snapshot per refresh cycle, shared across viewers

const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(DIACRITICS, '').trim();
}

function redisConfigured() { return !!(RURL && RTOKEN); }
async function redis(cmd) {
  const r = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RTOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// --- Event selection (kept in sync with api/claim.js) ---
const MAJOR_NAME_RE = /masters tournament|pga championship|u\.?s\.? ?open|open championship|\bthe open\b/i;
const NOT_MAJOR_RE = /senior|women|ladies|amateur|junior/i;
function looksLikeMajor(name) {
  const n = String(name || '');
  return MAJOR_NAME_RE.test(n) && !NOT_MAJOR_RE.test(n);
}

// Course par and ESPN's authoritative "major" flag live in the leaderboard API,
// not in the scoreboard feed.
export async function fetchEventMeta(eventId) {
  try {
    const r = await fetch(
      'https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=' +
      encodeURIComponent(eventId)
    );
    if (!r.ok) return null;
    const j = await r.json();
    const ev = j && j.events && j.events[0];
    if (!ev) return null;
    const par = Number(ev.courses?.[0]?.shotsToPar);
    return {
      major: !!ev.tournament?.major,
      par: (Number.isFinite(par) && par >= 50 && par <= 80) ? par : null,
      course: ev.courses?.[0]?.name || null,
    };
  } catch {
    return null;
  }
}

// Returns { event, meta } — meta is null when the leaderboard API was unreachable.
export async function selectEvent(events, configEventName) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return { event: null, meta: null };

  // 1. Organiser override: a configured event name that matches an event in the
  //    feed wins — this is how the app can run for a non-major if ever wanted.
  const want = String(configEventName || '').toLowerCase().trim();
  if (want) {
    const m = list.find(e => (e.name || '').toLowerCase().includes(want));
    if (m) return { event: m, meta: await fetchEventMeta(m.id) };
  }

  // 2. This week's major, per ESPN's tournament.major flag.
  const metas = await Promise.all(list.map(e => fetchEventMeta(e.id)));
  for (let i = 0; i < list.length; i++) {
    if (metas[i] && metas[i].major) return { event: list[i], meta: metas[i] };
  }

  // 3. Name heuristic, only for events whose meta lookup failed.
  for (let i = 0; i < list.length; i++) {
    if (!metas[i] && looksLikeMajor(list[i].name)) return { event: list[i], meta: null };
  }

  return { event: null, meta: null };
}

// --- ESPN parsing helpers (kept in sync with index.html) ---
function safeNum(v) {
  if (v == null || v === '' || v === '--' || v === '—') return null;
  if (typeof v === 'object') { const n = safeNum(v.value); return n !== null ? n : safeNum(v.displayValue); }
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function parseScoreStr(s) {
  if (!s || typeof s !== 'string') return null;
  s = s.trim();
  if (s === 'E' || s.toLowerCase() === 'even') return 0;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}
function extractRounds(c) {
  // Completed-round stroke totals only (ESPN stuffs holes-thru into linescores
  // mid-round, so we keep only plausible stroke totals > 50).
  const r = [null, null, null, null];
  if (Array.isArray(c.linescores)) {
    c.linescores.forEach((ls, i) => {
      if (i < 4) {
        let v = safeNum(ls);
        if (v == null && typeof ls === 'object') { v = safeNum(ls.value); if (v == null) v = safeNum(ls.displayValue); }
        if (v !== null && v > 50) r[i] = v;
      }
    });
  }
  if (r.every(x => x == null) && Array.isArray(c.statistics)) {
    const names = ['round1', 'round2', 'round3', 'round4'];
    c.statistics.forEach(st => {
      const idx = names.indexOf(st.name);
      if (idx !== -1) { const v = safeNum(st.value ?? st.displayValue); if (v !== null && v > 50) r[idx] = v; }
    });
  }
  return r;
}
function extractScoreToPar(c) {
  if (c.score && typeof c.score === 'object') { const s = parseScoreStr(c.score.displayValue); if (s !== null) return s; }
  if (typeof c.score === 'string') { const s = parseScoreStr(c.score); if (s !== null) return s; }
  if (Array.isArray(c.statistics)) {
    for (const st of c.statistics) {
      if (st.name === 'scoreToPar' || st.name === 'relativeScore') {
        let s = parseScoreStr(st.displayValue); if (s !== null) return s;
        s = safeNum(st.value); if (s !== null && s > -30 && s < 30) return s;
      }
    }
  }
  const raw = safeNum(c.score);
  if (raw !== null && raw > -30 && raw < 30) return raw;
  return null;
}
function extractStatusFlag(c) {
  const st = c.status || {}; const tp = st.type || {};
  const nm = (tp.name || '').toLowerCase();
  const desc = (tp.description || '').toLowerCase();
  const dv = (st.displayValue || '').toUpperCase();
  if (nm === 'cut' || desc.includes('cut') || dv === 'CUT' || dv.includes('MC')) return 'cut';
  if (nm === 'wd' || nm === 'withdrawn' || desc.includes('withdraw') || dv === 'WD') return 'wd';
  if (nm === 'dq' || nm === 'disqualified' || desc.includes('disqualif') || dv === 'DQ') return 'dq';
  return 'active';
}

async function maybeSnapshot(ev) {
  if (!redisConfigured() || !ev) return;
  // Cheap throttle check first so the common path is one tiny GET.
  const tsRaw = await redis(['GET', 'sweep:snap_ts']);
  const lastTs = tsRaw ? Number(tsRaw) : 0;
  const now = Date.now();
  if (now - lastTs < SNAPSHOT_THROTTLE_MS) return;

  const comps = ev?.competitions?.[0]?.competitors || ev?.competitors || [];
  if (comps.length === 0) return;

  let doc = { players: {} };
  const cur = await redis(['GET', 'sweep:golfers']);
  if (cur) { try { const p = JSON.parse(cur); if (p && p.players) doc = p; } catch { /* ignore */ } }

  // New tournament? Start a fresh snapshot so scores never bleed across events.
  const evId = String(ev.id || '');
  if (doc._eventId && evId && doc._eventId !== evId) doc = { players: {} };

  comps.forEach(c => {
    const name = c.athlete?.displayName || c.athlete?.fullName || c.athlete?.shortName;
    if (!name) return;
    const key = normName(name);
    const rounds = extractRounds(c);
    const scoreToPar = extractScoreToPar(c);
    const status = extractStatusFlag(c);
    const prev = doc.players[key] || {};
    // Merge-never-lose: keep a previously captured round if the current one is null.
    const mergedRounds = [0, 1, 2, 3].map(i => {
      if (rounds[i] != null) return rounds[i];
      if (Array.isArray(prev.rounds) && prev.rounds[i] != null) return prev.rounds[i];
      return null;
    });
    doc.players[key] = {
      name,
      rounds: mergedRounds,
      scoreToPar: scoreToPar != null ? scoreToPar : (prev.scoreToPar ?? null),
      status,
      updatedAt: now,
    };
  });

  doc._ts = now;
  doc._eventId = evId;
  doc._eventState = (ev.status?.type?.state || '').toLowerCase();
  doc._period = ev.status?.period || 0;
  await redis(['SET', 'sweep:golfers', JSON.stringify(doc)]);
  await redis(['SET', 'sweep:snap_ts', String(now)]);
}

export default async function handler(req, res) {
  // Allow the browser to read this data
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');

  try {
    // ESPN's public (unofficial) golf scoreboard endpoint
    const response = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'
    );
    const data = await response.json();

    // Organiser's event-name override, if one is configured (best-effort — the
    // majors need no config at all).
    let cfgName = '';
    if (redisConfigured()) {
      try {
        const c = JSON.parse(await redis(['GET', 'sweep:config']));
        if (c && c.eventName) cfgName = c.eventName;
      } catch { /* no config yet */ }
    }

    const { event: ev, meta } = await selectEvent(data.events, cfgName);

    // Snapshot round scores to Redis (throttled, fault-tolerant — never block scores).
    try { await maybeSnapshot(ev); } catch (e) { /* snapshot is best-effort */ }

    res.status(200).json({
      ...data,
      events: ev ? [ev] : [],
      sweepMeta: {
        eventId: ev ? String(ev.id) : null,
        eventName: ev ? (ev.name || null) : null,
        par: meta ? meta.par : null,
        course: meta ? meta.course : null,
        major: meta ? meta.major : null,
        allEvents: (data.events || []).map(e => ({ id: String(e.id), name: e.name })),
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
}

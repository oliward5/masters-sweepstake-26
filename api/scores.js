// This file runs on Vercel's servers (not in the browser).
// It fetches the Masters/PGA leaderboard from ESPN's public API and passes it back
// to the webpage, avoiding browser security restrictions.
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

async function maybeSnapshot(data) {
  if (!redisConfigured()) return;
  // Cheap throttle check first so the common path is one tiny GET.
  const tsRaw = await redis(['GET', 'sweep:snap_ts']);
  const lastTs = tsRaw ? Number(tsRaw) : 0;
  const now = Date.now();
  if (now - lastTs < SNAPSHOT_THROTTLE_MS) return;

  const ev = (data.events && data.events[0]) || null;
  const comps = ev?.competitions?.[0]?.competitors || ev?.competitors || [];
  if (comps.length === 0) return;

  let doc = { players: {} };
  const cur = await redis(['GET', 'sweep:golfers']);
  if (cur) { try { const p = JSON.parse(cur); if (p && p.players) doc = p; } catch { /* ignore */ } }

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

    // Snapshot round scores to Redis (throttled, fault-tolerant — never block scores).
    try { await maybeSnapshot(data); } catch (e) { /* snapshot is best-effort */ }

    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
}

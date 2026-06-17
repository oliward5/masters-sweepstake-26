// Runs on Vercel's servers. Handles a player claiming an unused name and submitting
// their 4 picks, in one atomic step. ALL validation is server-side (the client is
// untrusted): the name must be eligible, the 4 picks must be distinct players in the
// event field, and their OWGR-derived tiers must satisfy 1x Top-5 / 2x 6-25 / 1x 25+.
// The claim itself is made race-safe with Redis HSETNX (first writer wins).

const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(DIACRITICS, '').trim();
}

function tierForRank(rank) {
  if (rank == null) return '25+';      // unranked (amateurs/qualifiers) sit outside the top 25
  if (rank <= 5) return 'Top 5';
  if (rank <= 25) return '6-25';
  return '25+';
}

function redisConfigured() { return !!(RURL && RTOKEN); }

async function redis(cmd) {
  if (!redisConfigured()) throw new Error('REDIS_NOT_CONFIGURED');
  const r = await fetch(RURL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RTOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

// The event field = competitors of the configured event (or the in-focus one),
// matching how index.html selects the event.
async function fetchField(wantName) {
  const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard');
  const data = await res.json();
  let ev = null;
  if (data.events && data.events.length) {
    const want = String(wantName || '').toLowerCase().trim();
    if (want) ev = data.events.find(e => (e.name || '').toLowerCase().includes(want)) || null;
    ev = ev || data.events[0];
  }
  const comps = ev?.competitions?.[0]?.competitors || ev?.competitors || [];
  const byNorm = new Map();
  comps.forEach(c => {
    const name = c.athlete?.displayName || c.athlete?.fullName || c.athlete?.shortName;
    if (name) byNorm.set(normName(name), name);
  });
  return byNorm; // normName -> ESPN displayName
}

async function fetchRanks() {
  const res = await fetch('https://apiweb.owgr.com/api/owgr/rankings/getRankings?pageSize=1000&pageNumber=1');
  const data = await res.json();
  const rows = Array.isArray(data.rankingsList) ? data.rankingsList : [];
  const byNorm = new Map();
  rows.forEach(r => {
    const name = r.player?.fullName;
    if (name && r.rank != null) byNorm.set(normName(name), r.rank);
  });
  return byNorm; // normName -> rank
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  if (!redisConfigured()) return res.status(503).json({ error: 'REDIS_NOT_CONFIGURED' });

  try {
    const body = await readJson(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const picks = Array.isArray(body.picks) ? body.picks.map(p => String(p || '').trim()) : [];

    // 1. Config must exist.
    const configStr = await redis(['GET', 'sweep:config']);
    let cfg = null;
    try { cfg = JSON.parse(configStr); } catch { cfg = null; }
    if (!cfg) return res.status(503).json({ error: 'NOT_CONFIGURED' });

    // 2. Name must be eligible.
    const eligible = Array.isArray(cfg.eligibleNames) ? cfg.eligibleNames : [];
    if (!eligible.includes(name)) return res.status(400).json({ error: 'INVALID_NAME' });

    // 3. Exactly 4 distinct picks.
    if (picks.length !== 4) return res.status(400).json({ error: 'INVALID_PICKS', detail: 'Need exactly 4 picks.' });
    const distinct = new Set(picks.map(normName));
    if (distinct.size !== 4) return res.status(400).json({ error: 'INVALID_PICKS', detail: 'Picks must be distinct.' });

    // 4. Picks must all be in the event field; derive tiers from live OWGR rank.
    const [field, ranks] = await Promise.all([fetchField(cfg.eventName), fetchRanks()]);
    if (field.size === 0) return res.status(503).json({ error: 'FIELD_UNAVAILABLE', detail: 'Tournament field not published yet.' });

    const tiers = [];
    const rankList = [];
    for (const pick of picks) {
      const key = normName(pick);
      if (!field.has(key)) {
        return res.status(400).json({ error: 'INVALID_PICKS', detail: `"${pick}" is not in the field.` });
      }
      const rank = ranks.has(key) ? ranks.get(key) : null;
      rankList.push(rank);
      tiers.push(tierForRank(rank));
    }

    // 5. Tier rule: exactly 1x Top 5, 2x 6-25, 1x 25+.
    const counts = { 'Top 5': 0, '6-25': 0, '25+': 0 };
    tiers.forEach(t => { counts[t]++; });
    if (counts['Top 5'] !== 1 || counts['6-25'] !== 2 || counts['25+'] !== 1) {
      return res.status(400).json({
        error: 'TIER_RULE',
        detail: 'Need 1 from Top-5, 2 from 6-25, 1 from 25+.',
        counts,
      });
    }

    // Use the canonical ESPN display names so scoring joins exactly later.
    const canonicalPicks = picks.map(p => field.get(normName(p)));

    const entry = {
      name,
      picks: canonicalPicks,
      tiers,
      ranks: rankList,
      submittedAt: Date.now(),
      locked: true,
    };

    // 6. Atomic claim: first writer wins the name.
    const created = await redis(['HSETNX', 'sweep:entries', name, JSON.stringify(entry)]);
    if (created === 0 || created === '0') {
      return res.status(409).json({ error: 'NAME_TAKEN' });
    }

    res.status(200).json({ ok: true, entry });
  } catch (error) {
    res.status(500).json({ error: 'CLAIM_FAILED', detail: error.message });
  }
}

// Runs on Vercel's servers. Returns the full shared sweepstake state from Upstash
// Redis: the admin config, every submitted entry, and the golfer-score snapshot
// (used to keep missed-cut players' scores after ESPN drops them). No auth: picks
// are public (they already appear on the leaderboard). Never returns the admin token.

const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisConfigured() { return !!(RURL && RTOKEN); }

// Run several Redis commands in one round-trip. Returns results in order
// (a failed sub-command yields null rather than throwing the whole batch).
async function redisPipeline(cmds) {
  if (!redisConfigured()) throw new Error('REDIS_NOT_CONFIGURED');
  const r = await fetch(RURL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RTOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(j.error || 'Redis pipeline failed');
  return j.map(x => (x && x.error ? null : x && x.result));
}

// HGETALL over the REST API normally comes back as a flat [field, value, ...].
// Handle the object form too, just in case.
function hashToObject(flat) {
  const out = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i < flat.length - 1; i += 2) out[flat[i]] = flat[i + 1];
  } else if (flat && typeof flat === 'object') {
    return flat;
  }
  return out;
}

function safeParse(s, fallback) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (!redisConfigured()) {
    return res.status(200).json({
      configured: false, config: null, entries: [], golfers: {},
      takenNames: [], availableNames: [], storage: false,
    });
  }

  try {
    const [configStr, entriesFlat, golfersStr] = await redisPipeline([
      ['GET', 'sweep:config'],
      ['HGETALL', 'sweep:entries'],
      ['GET', 'sweep:golfers'],
    ]);

    const config = safeParse(configStr, null);
    const entriesMap = hashToObject(entriesFlat);
    const entries = Object.values(entriesMap)
      .map(v => safeParse(v, null))
      .filter(Boolean);
    const golfersDoc = safeParse(golfersStr, { players: {} });
    const golfers = (golfersDoc && golfersDoc.players) || {};

    const takenNames = entries.map(e => e.name);
    const eligible = (config && Array.isArray(config.eligibleNames)) ? config.eligibleNames : [];
    const availableNames = eligible.filter(n => !takenNames.includes(n));

    res.status(200).json({
      configured: !!config,
      config: config ? {
        eventName: config.eventName || '',
        par: config.par,
        eligibleNames: eligible,
      } : null,
      entries,
      golfers,
      takenNames,
      availableNames,
      storage: true,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load state', detail: error.message });
  }
}

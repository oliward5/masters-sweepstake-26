// Runs on Vercel's servers. Organiser-only operations, gated by a shared secret
// (the ADMIN_TOKEN env var). The token is sent in the request body and checked here
// on every call; it never lives in client-side code. Action-routed to keep the
// number of serverless functions low.

const RURL = process.env.UPSTASH_REDIS_REST_URL;
const RTOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  if (!ADMIN_TOKEN) return res.status(500).json({ error: 'ADMIN_NOT_CONFIGURED' });
  if (!redisConfigured()) return res.status(503).json({ error: 'REDIS_NOT_CONFIGURED' });

  try {
    const body = await readJson(req);
    if (!body.token || body.token !== ADMIN_TOKEN) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    switch (body.action) {
      case 'setConfig': {
        // Par is optional: it's auto-detected from ESPN for the selected event and
        // this value is only a manual fallback/override.
        let par = null;
        if (body.par !== '' && body.par != null) {
          par = Number(body.par);
          if (!Number.isFinite(par) || par < 50 || par > 80) {
            return res.status(400).json({ error: 'INVALID_PAR', detail: 'Par must be a number (e.g. 70, 72) or left blank for auto.' });
          }
        }
        const eventName = String(body.eventName || '').trim();
        const eligibleNames = Array.isArray(body.eligibleNames)
          ? body.eligibleNames.map(n => String(n || '').trim()).filter(Boolean)
          : [];
        if (eligibleNames.length === 0) {
          return res.status(400).json({ error: 'INVALID_NAMES', detail: 'Provide at least one eligible name.' });
        }
        if (new Set(eligibleNames).size !== eligibleNames.length) {
          return res.status(400).json({ error: 'INVALID_NAMES', detail: 'Eligible names must be unique.' });
        }
        const config = { eventName, par, eligibleNames, updatedAt: Date.now() };
        await redis(['SET', 'sweep:config', JSON.stringify(config)]);
        return res.status(200).json({ ok: true, config });
      }

      case 'resetEntry': {
        const target = String(body.target || '').trim();
        if (!target) return res.status(400).json({ error: 'NO_TARGET' });
        const removed = await redis(['HDEL', 'sweep:entries', target]);
        return res.status(200).json({ ok: true, removed });
      }

      case 'resetAll': {
        // Full reset for a new tournament: clear all entries AND the score snapshot.
        await redis(['DEL', 'sweep:entries']);
        await redis(['DEL', 'sweep:golfers']);
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ error: 'UNKNOWN_ACTION' });
    }
  } catch (error) {
    res.status(500).json({ error: 'ADMIN_FAILED', detail: error.message });
  }
}

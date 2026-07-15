# Golf Fathers Sweepstake

A live golf sweepstake web app. Eligible players claim their name, pick **4 golfers**
under the tier rules, and submit once (then their entry locks). The leaderboard builds
itself from everyone's picks plus live scores. Deployed on Vercel.

## How it works
- **The app follows the four majors automatically.** ESPN's feed can list several
  concurrent events (each major runs alongside an opposite-field tour event), so the
  server picks the one flagged `tournament.major` by ESPN — and reads the **course
  par** from the same API. Between majors the app shows a "waiting for the next
  major" notice. To run a non-major instead, set its name in `/#admin` (a configured
  event name that matches an event in the feed overrides major-detection).
- **Pick tiers come from the live world ranking (OWGR):** 1 golfer from world rank
  1–5, 2 from 6–25, and 1 from 26+.
- **You can only pick players in this week's field** (from ESPN).
- Lowest cumulative score-to-par wins. A golfer who **misses the cut** (or WD/DQ)
  scores their score-to-par after two rounds **+ 3 penalty shots**.
- Scores refresh automatically every 2 minutes.

## Tabs
- **Sweepstake** – entrants ranked by total; tap to expand their 4 picks.
- **My Pick** – claim your name and choose your golfers.
- **Full Leaderboard** – the whole field, with picked golfers highlighted.
- **Rules** – the above, plus a raw-data debug panel.

## Data sources
- **Scores / field:** ESPN public scoreboard API (free, no key) via `api/scores.js`.
- **Major flag / course par:** ESPN public leaderboard API (`tournament.major`,
  `courses[0].shotsToPar`), fetched per event by `api/scores.js` and `api/claim.js`.
- **World ranking / tiers:** OWGR public API via `api/rankings.js`.

ESPN deletes missed-cut players from its feed once a tournament finalises, so
`api/scores.js` snapshots each golfer's round scores into Redis (key `sweep:golfers`)
on a throttle. The front-end keeps applying the +3 penalty from that snapshot even
after a player disappears. The snapshot runs whenever anyone has the app open, and a
**Vercel Cron** (`vercel.json`) hits `/api/scores` daily at 23:00 UTC as a backstop so
at least one capture happens each day even if nobody's watching.

> The cron is set to **once a day** because Vercel's Hobby plan only allows daily
> crons. On a **Pro** plan, change the schedule in `vercel.json` to something frequent
> during tournament week (e.g. `"*/15 * * * *"` for every 15 minutes) for the most
> reliable cut capture.

## Setup (one-time)
1. **Create a free [Upstash](https://upstash.com) Redis database.** Copy its REST URL
   and REST token.
2. **In Vercel → Project → Settings → Environment Variables** (Production + Preview):
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `ADMIN_TOKEN` – a secret you choose, used to open the organiser screen.
3. **Redeploy** (env-var changes need a fresh deployment).
4. Open **`/#admin`**, enter your `ADMIN_TOKEN`, paste the eligible names (one per
   line), and **Save**. Event name and course par are **auto-detected** (only fill
   them in to run a non-major or override the par). No golfer list to enter —
   it's pulled live from OWGR and the field.
5. Share the URL. Everyone goes to **My Pick** to claim a name and submit.

Without the Redis env vars the app still shows the live leaderboard, but picks and
the sweepstake can't be saved.

## Endpoints
| Route | Purpose |
|-------|---------|
| `GET /api/scores` | ESPN proxy; also snapshots round scores to Redis (throttled) |
| `GET /api/rankings` | OWGR world ranking (slim, cached) |
| `GET /api/state` | Config + all entries + golfer snapshot |
| `POST /api/claim` | Claim a name + submit 4 picks (server-validated, race-safe) |
| `POST /api/admin` | Organiser: `setConfig` / `resetEntry` / `resetAll` (token-gated) |

## Organiser tasks
- **Reset one entry** (someone wants to re-pick): `/#admin` → Reset entries → pick name → Remove.
- **Start a new tournament:** `/#admin` → Reset ALL (clears entries and the score
  snapshot). That's it — the next major, its field, and its course par are picked up
  automatically. (The score snapshot also self-clears if it ever sees a new event id,
  so a forgotten reset can't leak scores across tournaments.)

No build step, no `package.json` — every `api/*.js` file is a standalone Vercel function.

// Runs on Vercel's servers (not in the browser).
// Fetches the Official World Golf Ranking from OWGR's public (unofficial) JSON API
// and returns a slim, normalised list so the app can group golfers into tiers
// (Top 5 / 6-25 / 25+) by their world rank. Avoids browser CORS restrictions.

// Strips combining diacritical marks (U+0300-U+036F). Built via RegExp() from an
// ASCII string so the source stays plain-text. Matches normName() in index.html.
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(DIACRITICS, '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Rankings change weekly, so cache hard at the edge.
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  try {
    const response = await fetch(
      'https://apiweb.owgr.com/api/owgr/rankings/getRankings?pageSize=1000&pageNumber=1',
      { headers: { 'Accept': 'application/json' } }
    );
    if (!response.ok) throw new Error('OWGR returned ' + response.status);
    const data = await response.json();

    const rows = Array.isArray(data.rankingsList) ? data.rankingsList : [];
    const rankings = rows.map(r => {
      const name = r.player?.fullName
        || [r.player?.firstName, r.player?.lastName].filter(Boolean).join(' ');
      return {
        rank: r.rank,
        name,
        normName: normName(name),
        isAmateur: !!r.player?.isAmateur,
      };
    }).filter(r => r.name && r.rank != null);

    res.status(200).json({ rankings, count: rankings.length });
  } catch (error) {
    res.status(502).json({ error: 'Failed to fetch rankings', detail: error.message });
  }
}

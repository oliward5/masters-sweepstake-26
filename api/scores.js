// This file runs on Vercel's servers (not in the browser).
// It fetches the Masters leaderboard from ESPN's public API
// and passes it back to your webpage, avoiding browser security restrictions.

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
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch scores' });
  }
}

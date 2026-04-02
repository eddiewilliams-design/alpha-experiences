// ============================================================
// ALPHA EXPERIENCES — GET SESSIONS API
// Vercel Serverless Function
// GET /api/get-sessions
// Reads Sessions tab from Google Sheet and returns session data
// ============================================================

const https = require('https');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const RANGE    = 'Sessions!A:G';

function fetchSheet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Failed to parse sheet response')); }
      });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}?key=${apiKey}`;
    const data = await fetchSheet(url);
    const rows = (data.values || []).slice(1); // skip header row

    const sessions = rows
      .filter(row => row[0]) // skip empty rows
      .map((row, i) => ({
        id:          'session_' + i,
        name:        row[0] || '',
        emoji:       row[1] || '🎯',
        coach:       row[2] || '',
        day:         row[3] || '',
        time:        row[4] || '',
        description: row[5] || '',
        link:        row[6] || ''
      }));

    return res.status(200).json({ sessions });
  } catch(err) {
    console.error('get-sessions error:', err.message);
    return res.status(500).json({ error: 'Failed to load sessions' });
  }
};

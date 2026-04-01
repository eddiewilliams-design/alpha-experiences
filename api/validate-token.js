// ============================================================
// ALPHA EXPERIENCES — TOKEN VALIDATION API
// Vercel Serverless Function
// GET /api/validate-token?token=XXXXXXXX
// Returns: { valid, mode, name } or { valid: false, reason }
// ============================================================

const https = require('https');

const SHEET_ID = '1aQYysCOOR-mYG8Myrl1BSU2PF8wMl-si8pgNG89sRto';
const RANGE    = 'Sheet1!A:I';

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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token  = (req.query.token || '').trim();
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;

  if (!token) {
    return res.status(400).json({ valid: false, reason: 'no_token' });
  }

  if (!apiKey) {
    return res.status(500).json({ valid: false, reason: 'server_config_error' });
  }

  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}?key=${apiKey}`;
    const data = await fetchSheet(url);
    const rows = (data.values || []);

    // Row 0 = headers. Token in col G (index 6), Active in col H (index 7), ExpType in col A (index 0)
    for (let i = 1; i < rows.length; i++) {
      const row      = rows[i];
      const rowToken = (row[6] || '').trim();
      if (rowToken !== token) continue;

      const active   = (row[7] || '').toString().trim();
      const expType  = (row[0] || '');
      const name     = (row[1] || '').split(' ')[0]; // first name only

      if (active !== 'TRUE') {
        return res.status(403).json({ valid: false, reason: 'inactive' });
      }

      const mode = expType.indexOf('2 Sessions') === -1 ? 'full' : 'two';
      return res.status(200).json({ valid: true, mode, name });
    }

    return res.status(404).json({ valid: false, reason: 'not_found' });

  } catch (err) {
    console.error('validate-token error:', err.message);
    return res.status(500).json({ valid: false, reason: 'server_error' });
  }
};

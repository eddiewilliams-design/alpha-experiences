// ============================================================
// ALPHA EXPERIENCES — LUL EMAIL MODULE (via Intercom)
//
// Node port of the Apps Script `sendPendingEmails` flow so the
// Vercel admin can send LUL welcome emails directly when a pass
// is created via /admin/lounge/passes. Intercom is the same path
// the Apps Script uses — same admin id, same template style.
//
// Templates are intentionally byte-identical to the Apps Script
// versions (`buildEmailBody` / `buildCelebrationEmailBody`) so a
// student gets the same email regardless of whether the pass was
// created in the sheet (Apps Script onEdit) or in the portal.
// If you tweak one, mirror the change in the other.
//
// Required env var: INTERCOM_ACCESS_TOKEN (Vercel)
// ============================================================

const https = require('https');

const INTERCOM_ADMIN_ID = '10384075';
const VERCEL_BASE_URL   = 'https://alpha-experiences.vercel.app/lul';
const ALPHA_LOGO_URL    = 'https://i.imgur.com/DaRDdu5.png';

// ── HTTP to Intercom ─────────────────────────────────────────
function intercomRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.INTERCOM_ACCESS_TOKEN;
    if (!token) return reject(new Error('INTERCOM_ACCESS_TOKEN not set in Vercel env'));

    const buf = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      method,
      hostname: 'api.intercom.io',
      path,
      headers: Object.assign({
        'Authorization':    'Bearer ' + token,
        'Accept':           'application/json',
        'Content-Type':     'application/json',
        'Intercom-Version': '2.11'
      }, buf ? { 'Content-Length': buf.length } : {})
    };

    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end',  () => {
        let parsed = null;
        try { parsed = d ? JSON.parse(d) : {}; } catch (_) { parsed = { raw: d }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const err = new Error('Intercom ' + method + ' ' + path + ' → ' + res.statusCode + ': ' + d);
        err.status = res.statusCode;
        err.intercom = parsed;
        reject(err);
      });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

async function getOrCreateContact(email, name) {
  const search = await intercomRequest('/contacts/search', 'POST', {
    query: { field: 'email', operator: '=', value: email }
  });
  const existing = (search && search.data) || [];
  if (existing.length > 0) return existing[0].id;

  const created = await intercomRequest('/contacts', 'POST', {
    role: 'user', email: email, name: name || ''
  });
  if (!created || !created.id) throw new Error('Intercom: failed to create contact for ' + email);
  return created.id;
}

async function sendViaIntercom({ to, name, subject, html }) {
  const contactId = await getOrCreateContact(to, name || '');
  return intercomRequest('/messages', 'POST', {
    message_type: 'email',
    subject:      subject,
    body:         html,
    template:     'plain',
    from:         { type: 'admin',   id: INTERCOM_ADMIN_ID },
    to:           { type: 'contact', id: contactId }
  });
}

// ── Email Templates (PORT of Apps Script — keep in sync) ─────
function buildEmailBody(studentName, passLabel, sessionUrl, recipient) {
  const greeting = recipient === 'parent'
    ? `Hey <strong>${studentName}'s family</strong>!`
    : `Hey <strong>${studentName}</strong>!`;

  const intro = recipient === 'parent'
    ? `${studentName}'s Level Up Lounge sessions are locked in for this week. Click below to view the sessions and Zoom links:`
    : `Your Level Up Lounge sessions are locked in for this week. Click below to view your sessions and Zoom links:`;

  return `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#F9FAFB;">
      <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <div style="background:#072256;padding:24px 32px;text-align:center;">
          <img src="${ALPHA_LOGO_URL}" alt="Alpha Anywhere" width="120"
               style="display:block;margin:0 auto 16px;height:auto;" />
          <p style="color:#FFB800;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 8px;">
            Level Up Lounge · Alpha Experiences
          </p>
          <h1 style="color:#fff;font-size:24px;margin:0 0 6px;">You're In! 🎉</h1>
          <p style="color:#AAB8D3;font-size:14px;margin:0;">${passLabel}</p>
        </div>

        <!-- Body -->
        <div style="padding:28px 32px;text-align:center;">
          <p style="color:#374151;font-size:15px;text-align:left;">${greeting}</p>
          <p style="color:#374151;font-size:15px;text-align:left;">${intro}</p>

          <a href="${sessionUrl}"
             style="display:inline-block;margin:24px auto;background:#006AFF;color:#fff;padding:14px 36px;border-radius:999px;text-decoration:none;font-size:15px;font-weight:700;">
            View My Sessions →
          </a>

          <p style="color:#6B7280;font-size:13px;text-align:left;margin-top:20px;">
            ⚠️ Session links are <strong>one-time use only</strong> and expire 30 days from the date of issue. Don't click a link until you're ready to join — it won't work a second time!
          </p>
          <p style="color:#6B7280;font-size:13px;text-align:left;">
            📅 All sessions are subject to coach availability.
          </p>
          <p style="color:#6B7280;font-size:13px;text-align:left;">
            💬 Questions? Reply to this email or message your coach on the platform.
          </p>

          <!-- Fine Print -->
          <p style="color:#9CA3AF;font-size:11px;text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #E5E7EB;line-height:1.6;">
            All sessions are subject to coach availability. One-time use Zoom links expire 30 days from the date of issue. By accessing your pass you agree to these terms.
          </p>
        </div>

        <!-- Footer -->
        <div style="background:#072256;padding:16px 32px;text-align:center;">
          <p style="color:#AAB8D3;font-size:12px;margin:0;">
            Breakthrough Coaching · Alpha Anywhere<br>
            breakthroughcoaching@2hourlearning.com
          </p>
        </div>

      </div>
    </body>
    </html>
  `;
}

function buildCelebrationEmailBody(studentName, sessionUrl, recipient) {
  const greeting = recipient === 'parent'
    ? `Hey <strong>${studentName}'s family</strong>!`
    : `Hey <strong>${studentName}</strong>!`;

  const intro = recipient === 'parent'
    ? `${studentName} earned a spot at the Friday Coaching Celebration! Click below to lock in their spot and get the Zoom link:`
    : `You earned a spot at the Friday Coaching Celebration! Click below to lock in your spot and get your Zoom link:`;

  return `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#F9FAFB;">
      <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <div style="background:#072256;padding:24px 32px;text-align:center;">
          <img src="${ALPHA_LOGO_URL}" alt="Alpha Anywhere" width="120"
               style="display:block;margin:0 auto 16px;height:auto;" />
          <p style="color:#FFB800;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 8px;">
            Level Up Lounge · Alpha Experiences
          </p>
          <h1 style="color:#fff;font-size:24px;margin:0 0 6px;">You Earned It! 🎊</h1>
          <p style="color:#AAB8D3;font-size:14px;margin:0;">Friday Coaching Celebration</p>
        </div>

        <!-- Body -->
        <div style="padding:28px 32px;text-align:center;">
          <p style="color:#374151;font-size:15px;text-align:left;">${greeting}</p>
          <p style="color:#374151;font-size:15px;text-align:left;">${intro}</p>

          <a href="${sessionUrl}"
             style="display:inline-block;margin:24px auto;background:#006AFF;color:#fff;padding:14px 36px;border-radius:999px;text-decoration:none;font-size:15px;font-weight:700;">
            Lock In My Spot 🎊
          </a>

          <p style="color:#6B7280;font-size:13px;text-align:left;margin-top:20px;">
            ⚠️ This link is <strong>one-time use only</strong> and expires 30 days from the date of issue. Don't click it until you're ready to lock in your spot — it won't work a second time!
          </p>
          <p style="color:#6B7280;font-size:13px;text-align:left;">
            📅 All sessions are subject to coach availability.
          </p>
          <p style="color:#6B7280;font-size:13px;text-align:left;">
            💬 Questions? Reply to this email or message your coach on the platform.
          </p>

          <!-- Fine Print -->
          <p style="color:#9CA3AF;font-size:11px;text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #E5E7EB;line-height:1.6;">
            All sessions are subject to coach availability. One-time use Zoom links expire 30 days from the date of issue. By accessing your pass you agree to these terms.
          </p>
        </div>

        <!-- Footer -->
        <div style="background:#072256;padding:16px 32px;text-align:center;">
          <p style="color:#AAB8D3;font-size:12px;margin:0;">
            Breakthrough Coaching · Alpha Anywhere<br>
            breakthroughcoaching@2hourlearning.com
          </p>
        </div>

      </div>
    </body>
    </html>
  `;
}

// ── Public API ───────────────────────────────────────────────
//
// sendWelcomeEmail({
//   name, email, parentEmail, expType, mode, token
// })
//
// `mode` is the resolved mode from the LUL_Pass_Types config:
//   - 'celebration' → Friday Coaching Celebration template
//   - 'full'        → Full Week Pass template
//   - 'pick'        → 2-Session-style template (any pick count)
//
// If the row's `expType` is unknown to LUL_Pass_Types, callers
// should fall back to the legacy detection (Apps Script style):
//   .includes('friday coaching celebration') → celebration
//   .includes('2 sessions')                  → pick
//   else                                     → full
// — that's handled in api/admin/[action].js, not here.
//
// Throws on Intercom failure. The caller is responsible for
// stamping `Email Sent = Yes` in Sheet1 (or recording errors).
async function sendWelcomeEmail({ name, email, parentEmail, expType, mode, token }) {
  if (!email)    throw new Error('email required');
  if (!token)    throw new Error('token required');
  const sessionUrl = `${VERCEL_BASE_URL}?token=${encodeURIComponent(token)}`;

  let passLabel, subject, studentBody, parentBody;

  if (mode === 'celebration') {
    passLabel   = 'Friday Coaching Celebration 🎊';
    subject     = `🎊 You're In! Your Friday Coaching Celebration Link`;
    studentBody = buildCelebrationEmailBody(name, sessionUrl, 'student');
    parentBody  = buildCelebrationEmailBody(name, sessionUrl, 'parent');
  } else if (mode === 'full') {
    passLabel   = 'Full Week Pass 🎟️';
    subject     = `🎟️ Your Full Week LUL Pass — All Links Inside!`;
    studentBody = buildEmailBody(name, passLabel, sessionUrl, 'student');
    parentBody  = buildEmailBody(name, passLabel, sessionUrl, 'parent');
  } else {
    // 'pick' (or anything unrecognised — same template as 2-session)
    passLabel   = '2-Session Pass 🎟️';
    subject     = `🎟️ Your LUL Sessions Are Confirmed!`;
    studentBody = buildEmailBody(name, passLabel, sessionUrl, 'student');
    parentBody  = buildEmailBody(name, passLabel, sessionUrl, 'parent');
  }

  await sendViaIntercom({ to: email, name: name || '', subject, html: studentBody });

  if (parentEmail && String(parentEmail).trim()) {
    await sendViaIntercom({ to: String(parentEmail).trim(), name: name || '', subject, html: parentBody });
  }
}

module.exports = { sendWelcomeEmail };

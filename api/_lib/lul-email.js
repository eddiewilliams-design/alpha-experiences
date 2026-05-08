// ============================================================
// ALPHA EXPERIENCES — LUL EMAIL MODULE (via Intercom)
//
// Node port of the Apps Script `sendPendingEmails` flow so the
// Vercel admin can send LUL welcome emails directly when a pass
// is created via /admin/lounge/passes. Same Intercom path the
// Apps Script uses — same admin id, same brand-aligned shell.
//
// IMPORTANT: this file diverged from the Apps Script template in
// the brand-polish pass. To keep both flows visually identical,
// mirror these template changes back into Apps Script (or accept
// that legacy sheet-added passes get the older template).
//
// Required env var: INTERCOM_ACCESS_TOKEN (Vercel)
// ============================================================

const https = require('https');

const INTERCOM_ADMIN_ID = '10384075';
const VERCEL_BASE_URL   = 'https://alpha-experiences.vercel.app/lul';
const ALPHA_LOGO_URL    = 'https://i.imgur.com/DaRDdu5.png';

// Brand colors (Alpha Anywhere)
const C = {
  navy:       '#072256',
  blue:       '#006FF9',
  yellow:     '#E59500',
  lightYellow:'#FFF7E5',
  yellowBorder:'#F0D39B',
  yellowText: '#6B3A00',
  bg:         '#FAFAFA',
  card:       '#FFFFFF',
  text:       '#072256',
  muted:      '#8291AA',
  border:     '#EEF0F3'
};

// System-sans stack (emails can't reliably load AF Sobremesa / Be Vietnam Pro)
const FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif';

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

// ── Brand-aligned email shell ────────────────────────────────
// Three-tier hierarchy: small overline / heading / sub-paragraph.
// One anchor card (the CTA). Single yellow reminder. Footer with
// reply-to. No inline-word highlights.
function shell({ overline, heading, intro, ctaUrl, ctaLabel, recipient }) {
  const replyHelp = recipient === 'parent'
    ? `Questions? Reply to this email — your student's coach can also help on the Alpha Anywhere platform.`
    : `Questions? Reply to this email or message your coach.`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:${FONT};background:${C.bg};color:${C.text};-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.bg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:${C.card};border-radius:20px;overflow:hidden;box-shadow:0 4px 20px rgba(7,34,86,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:${C.navy};padding:28px 36px;">
              <img src="${ALPHA_LOGO_URL}" alt="Alpha Anywhere" width="120" style="display:block;height:auto;border:0;outline:none;text-decoration:none;" />
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 36px 24px;">
              <p style="margin:0 0 10px;color:${C.muted};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${overline}</p>
              <h1 style="margin:0 0 14px;color:${C.navy};font-size:24px;font-weight:800;line-height:1.2;letter-spacing:-0.01em;">${heading}</h1>
              <p style="margin:0 0 28px;color:${C.text};font-size:15px;line-height:1.6;">${intro}</p>

              <!-- Anchor CTA (table-based for Outlook compatibility) -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px;">
                <tr>
                  <td style="background:${C.blue};border-radius:999px;">
                    <a href="${ctaUrl}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.02em;font-family:${FONT};">${ctaLabel}</a>
                  </td>
                </tr>
              </table>

              <!-- Single combined reminder -->
              <div style="background:${C.lightYellow};border:1px solid ${C.yellowBorder};border-radius:12px;padding:14px 16px;color:${C.yellowText};font-size:13px;line-height:1.55;">
                <strong>One-time use.</strong> Each Zoom link works once and expires 30 days from the date issued. Click only when you're ready to join.
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:18px 36px 28px;border-top:1px solid ${C.border};">
              <p style="margin:0 0 8px;color:${C.muted};font-size:12px;line-height:1.5;">
                ${replyHelp}
              </p>
              <p style="margin:0;color:${C.muted};font-size:10px;letter-spacing:0.06em;text-transform:uppercase;font-weight:700;">
                Alpha Experiences · Alpha Anywhere
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Subject + body composers per mode ────────────────────────
function buildPickEmail({ studentName, pickCount, sessionUrl, recipient }) {
  const overline = 'Level Up Lounge';
  const n = (pickCount && pickCount > 0) ? pickCount : 2;

  const heading = recipient === 'parent'
    ? `${studentName} has a new Lounge pass`
    : `Your Lounge pass is here, ${studentName}`;

  const intro = recipient === 'parent'
    ? `${studentName}'s ${n}-session pass is ready. They'll pick which sessions they want and lock in their Zoom links from the link below.`
    : `Pick your ${n} sessions for this week. Your Zoom links unlock 15 min before each session starts.`;

  return shell({
    overline,
    heading,
    intro,
    ctaUrl:   sessionUrl,
    ctaLabel: 'Pick my sessions →',
    recipient
  });
}

function buildFullWeekEmail({ studentName, sessionUrl, recipient }) {
  const overline = 'Level Up Lounge';

  const heading = recipient === 'parent'
    ? `${studentName} has a Full Week Lounge pass`
    : `Your Full Week pass is here, ${studentName}`;

  const intro = recipient === 'parent'
    ? `${studentName} can join every Lounge session this week. Zoom links are inside — they unlock 15 min before each session starts.`
    : `You can join every Lounge session this week. Click below to see what's on — Zoom links unlock 15 min before each session.`;

  return shell({
    overline,
    heading,
    intro,
    ctaUrl:   sessionUrl,
    ctaLabel: 'View my sessions →',
    recipient
  });
}

function buildCelebrationEmail({ studentName, sessionUrl, recipient }) {
  const overline = 'Friday Coaching Celebration';

  const heading = recipient === 'parent'
    ? `${studentName} earned a Celebration spot`
    : `You earned it, ${studentName}`;

  const intro = recipient === 'parent'
    ? `${studentName} earned a spot at this Friday's Coaching Celebration. Tap below to lock in their spot and get the Zoom link.`
    : `You earned a spot at this Friday's Coaching Celebration. Click below to lock in your spot and grab the Zoom link.`;

  return shell({
    overline,
    heading,
    intro,
    ctaUrl:   sessionUrl,
    ctaLabel: 'Lock in my spot →',
    recipient
  });
}

// ── Public API ───────────────────────────────────────────────
//
// sendWelcomeEmail({ name, email, parentEmail, expType, mode, pickCount, token })
//
// `mode` is the resolved mode from LUL_Pass_Types:
//   - 'celebration' → Friday Coaching Celebration template
//   - 'full'        → Full Week Pass template
//   - 'pick'        → Pick-N-sessions template
//
// Throws on Intercom failure. Caller is responsible for stamping
// `Email Sent = Yes` in Sheet1 (or recording errors on failure).
async function sendWelcomeEmail({ name, email, parentEmail, expType, mode, pickCount, token }) {
  if (!email) throw new Error('email required');
  if (!token) throw new Error('token required');
  const sessionUrl = `${VERCEL_BASE_URL}?token=${encodeURIComponent(token)}`;
  const studentName = name || 'there';

  let subject, studentBody, parentBody;

  if (mode === 'celebration') {
    subject     = `🎊 You earned a Friday Celebration spot`;
    studentBody = buildCelebrationEmail({ studentName, sessionUrl, recipient: 'student' });
    parentBody  = buildCelebrationEmail({ studentName, sessionUrl, recipient: 'parent'  });
  } else if (mode === 'full') {
    subject     = `Your Full Week Lounge pass is here`;
    studentBody = buildFullWeekEmail({ studentName, sessionUrl, recipient: 'student' });
    parentBody  = buildFullWeekEmail({ studentName, sessionUrl, recipient: 'parent'  });
  } else {
    // pick mode (default fallback)
    const n = (pickCount && pickCount > 0) ? pickCount : 2;
    subject     = `Your Lounge pass — pick ${n} sessions`;
    studentBody = buildPickEmail({ studentName, pickCount: n, sessionUrl, recipient: 'student' });
    parentBody  = buildPickEmail({ studentName, pickCount: n, sessionUrl, recipient: 'parent'  });
  }

  await sendViaIntercom({ to: email, name: studentName, subject, html: studentBody });

  if (parentEmail && String(parentEmail).trim()) {
    await sendViaIntercom({
      to: String(parentEmail).trim(),
      name: studentName,
      subject,
      html: parentBody
    });
  }
}

module.exports = { sendWelcomeEmail };

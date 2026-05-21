// ============================================================
// ALPHA EXPERIENCES — VFT REGISTRATION EMAIL MODULE (via Intercom)
//
// Sends the confirmation email after an admin manually registers
// a student for a Virtual Field Trip via /admin/registrations.
//
// Sends ONE email per recipient (Intercom's /messages API binds to
// one contact at a time). Copy is tailored per recipient — student
// version says "you", parent version says "your student's name".
//
// Workspace is the SAME Intercom workspace as LUL, but the "from"
// admin/teammate is different (the new Alpha Experiences sender)
// so the email lands from the right inbox. The access token is
// workspace-scoped — reuses INTERCOM_ACCESS_TOKEN.
//
// Required env vars: INTERCOM_ACCESS_TOKEN (Vercel)
// ============================================================

const https = require('https');

// Intercom admin/teammate ID for the "Experiences" sender (renders as
// "Experiences from Alpha Anywhere" in recipient inboxes). Set 2026-05-21
// after Eddie's coworker created the new teammate in Intercom.
// To rotate: Settings → Teammates → click the teammate → numeric ID is
// in the URL (…/admins/<number>).
const INTERCOM_ADMIN_ID = '10667875';

const VERCEL_BASE_URL = 'https://alpha-experiences.vercel.app';
const ALPHA_LOGO_URL  = 'https://i.imgur.com/DaRDdu5.png';

// Brand colors (Alpha Anywhere)
const C = {
  navy:        '#072256',
  blue:        '#006FF9',
  yellow:      '#E59500',
  lightYellow: '#FFF7E5',
  yellowBorder:'#F0D39B',
  yellowText:  '#6B3A00',
  bg:          '#FAFAFA',
  card:        '#FFFFFF',
  text:        '#072256',
  muted:       '#8291AA',
  border:      '#EEF0F3'
};

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

// ── Helpers ──────────────────────────────────────────────────
function firstName(fullName) {
  if (!fullName) return 'there';
  const parts = String(fullName).trim().split(/\s+/);
  return parts[0] || 'there';
}

// Strip the internal "AA VFT: " prefix from trip titles so the
// parent-facing email reads naturally.
function cleanTripTitle(title) {
  if (!title) return '';
  return String(title).replace(/^\s*AA\s*VFT\s*:\s*/i, '').trim();
}

// Wrap a phrase in AA Yellow for the hero highlight (mirrors LUL).
function hl(text) {
  return `<span style="color:${C.yellow};">${text}</span>`;
}

// Escape user-supplied text before injecting into HTML.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Brand-aligned email shell (mirrors LUL pattern) ──────────
function shell({ overline, headingHtml, intro, ctaUrl, ctaLabel, reminderHtml, replyHelp }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:${FONT};background:${C.bg};color:${C.text};-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.bg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:${C.card};border-radius:20px;overflow:hidden;box-shadow:0 4px 20px rgba(7,34,86,0.08);">

          <!-- Navy hero band -->
          <tr>
            <td style="background:${C.navy};padding:32px 36px 30px;">
              <img src="${ALPHA_LOGO_URL}" alt="Alpha Anywhere" width="120" style="display:block;height:auto;border:0;outline:none;text-decoration:none;margin:0 0 22px;" />
              <p style="margin:0 0 10px;color:${C.yellow};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${overline}</p>
              <h1 style="margin:0 0 12px;color:#ffffff;font-size:26px;font-weight:800;line-height:1.2;letter-spacing:-0.01em;">${headingHtml}</h1>
              <p style="margin:0;color:rgba(255,255,255,0.85);font-size:14px;line-height:1.6;">${intro}</p>
            </td>
          </tr>

          <!-- Yellow accent stripe -->
          <tr>
            <td bgcolor="${C.yellow}" style="background:${C.yellow};height:4px;line-height:4px;font-size:0;mso-line-height-rule:exactly;">&nbsp;</td>
          </tr>

          <!-- Body card: CTA + reminder -->
          <tr>
            <td style="background:${C.card};padding:32px 36px 24px;text-align:center;">
              <div style="text-align:center;margin:0 auto 24px;">
                <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:20px 52px;background:${C.blue};color:#ffffff;font-family:${FONT};font-size:20px;font-weight:900;text-decoration:none;border-radius:999px;line-height:1;mso-line-height-rule:exactly;letter-spacing:0.02em;">${ctaLabel}</a>
              </div>

              <div style="background:${C.lightYellow};border:1px solid ${C.yellowBorder};border-radius:12px;padding:14px 16px;color:${C.yellowText};font-size:13px;line-height:1.55;text-align:left;">
                ${reminderHtml}
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

// ── Body composers per recipient ─────────────────────────────
function buildStudentBody({ studentFirst, displayTitle, sessionDateCt, tripUrl }) {
  return shell({
    overline:    'Virtual Field Trip',
    headingHtml: `You're going to ${hl(esc(displayTitle))}, ${esc(studentFirst)}`,
    intro:       `You're registered for ${esc(displayTitle)} on ${esc(sessionDateCt)}. Tap below to find your trip in the portal and see what to prep before your session.`,
    ctaUrl:      tripUrl,
    ctaLabel:    'View my trip →',
    reminderHtml: `<strong>What's next:</strong> More details will land in your inbox closer to your session, and your live session link will unlock in the portal 15 minutes before you start.`,
    replyHelp:   `Need to change or cancel? Just reply to this email — or message your coach.`
  });
}

function buildParentBody({ studentFirst, displayTitle, sessionDateCt, tripUrl }) {
  return shell({
    overline:    'Virtual Field Trip',
    headingHtml: `${esc(studentFirst)}'s ${hl(esc(displayTitle))} trip is set`,
    intro:       `${esc(studentFirst)} is registered for ${esc(displayTitle)} on ${esc(sessionDateCt)}. They can find the trip and any prep materials in the Alpha Experiences portal.`,
    ctaUrl:      tripUrl,
    ctaLabel:    `View ${esc(studentFirst)}'s trip →`,
    reminderHtml: `<strong>What's next:</strong> More details will land in your inbox closer to the session. ${esc(studentFirst)}'s live session link will unlock in the portal 15 minutes before they start.`,
    replyHelp:   `Need to change or cancel? Reply to this email — your student's coach can also help on the Alpha Anywhere platform.`
  });
}

// ── Public API ───────────────────────────────────────────────
//
// sendRegistrationEmail({
//   studentName, studentEmail, parentEmail,
//   tripId, tripTitle, sessionDateCt
// })
//
// `sessionDateCt` is the pre-formatted display string built by the
// caller in America/Chicago — e.g. "Thu, May 21 at 1:00 PM CT".
// `tripTitle` can include the internal "AA VFT: " prefix; this
// helper strips it for display.
//
// Sends two emails (student + parent) when parentEmail is present,
// one email (student) otherwise. Throws on Intercom failure so the
// caller can decide whether to surface to the admin UI.
async function sendRegistrationEmail({
  studentName,
  studentEmail,
  parentEmail,
  tripId,
  tripTitle,
  sessionDateCt
}) {
  if (!studentEmail) throw new Error('studentEmail required');
  if (!tripId)      throw new Error('tripId required');

  const studentFirst  = firstName(studentName);
  const displayTitle  = cleanTripTitle(tripTitle) || 'your virtual field trip';
  const tripUrl       = `${VERCEL_BASE_URL}/trips/${encodeURIComponent(tripId)}`;
  const dateForSubj   = sessionDateCt || '';

  const studentSubject = `Your virtual field trip to ${displayTitle} is set`;
  const parentSubject  = `${studentFirst} is registered: ${displayTitle} virtual field trip`;

  const studentHtml = buildStudentBody({ studentFirst, displayTitle, sessionDateCt: dateForSubj, tripUrl });

  await sendViaIntercom({
    to:      studentEmail,
    name:    studentName,
    subject: studentSubject,
    html:    studentHtml
  });

  if (parentEmail && String(parentEmail).trim()) {
    const parentHtml = buildParentBody({ studentFirst, displayTitle, sessionDateCt: dateForSubj, tripUrl });
    await sendViaIntercom({
      to:      String(parentEmail).trim(),
      name:    studentName,
      subject: parentSubject,
      html:    parentHtml
    });
  }
}

module.exports = { sendRegistrationEmail };

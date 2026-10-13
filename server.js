const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Translated editions live under /<code>/. English is the root.
const LANGS = ['ar', 'zh', 'ja', 'ko', 'id', 'ms', 'es', 'fr', 'it', 'pt', 'el', 'de', 'fi', 'da', 'ro', 'sw', 'ru', 'ky', 'kk', 'tr'];
const SUPPORTED = new Set(['en', ...LANGS]);
const BOTS = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|lighthouse|headless/i;

function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// Best supported language from Accept-Language, honouring q-values. null = none supported.
function preferredLanguage(header) {
  if (!header) return null;
  const tags = header.split(',').map((part, i) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const base = tag.trim().toLowerCase().split('-')[0];
    return { base: base === 'in' ? 'id' : base, q: q ? parseFloat(q.slice(2)) || 0 : 1, i }; // 'in' = legacy code for Indonesian
  }).filter(t => t.base && t.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  const hit = tags.find(t => SUPPORTED.has(t.base));
  return hit ? hit.base : null;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

// ------------------------------------------------------------------ visitor analytics
// Cloudflare Web Analytics: cookie-free, aggregate page-view counts (query strings are stripped).
// The beacon token is public by design (it ships to every visitor's browser), so it lives in code.
// The tag is injected into HTML responses on the production host only, so local previews and the
// *.up.railway.app address never count. Set CF_BEACON_TOKEN=off on Railway to switch it off.
// If a Content-Security-Policy is ever added, allow script-src https://static.cloudflareinsights.com
// and connect-src https://cloudflareinsights.com.
const CF_BEACON_TOKEN = process.env.CF_BEACON_TOKEN || 'ef7c48673a924b22be3d74683aeca15f';
const CF_BEACON_TAG = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${JSON.stringify({ token: CF_BEACON_TOKEN, spa: false })}'></script>`;
const ANALYTICS_HOST = /^(www\.)?heirstoneconsulting\.com$/i;

function withAnalytics(req, html) {
  if (CF_BEACON_TOKEN === 'off') return html;
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!ANALYTICS_HOST.test(host)) return html;
  const page = html.toString('utf8');
  const at = page.lastIndexOf('</body>');
  return at === -1 ? page + CF_BEACON_TAG : page.slice(0, at) + CF_BEACON_TAG + '\n' + page.slice(at);
}

// ------------------------------------------------------------------ contact form -> Resend
// POST /api/contact sends the enquiry through Resend (https://resend.com).
// Settings: RESEND_API_KEY (required), CONTACT_TO (comma list), CONTACT_FROM (verified domain).
// With no key, or if Resend fails, the reply says { fallback: true } and the page uses FormSubmit instead.
const CONTACT_TO = (process.env.CONTACT_TO || 'info@heirstoneconsulting.com').split(',').map(s => s.trim()).filter(Boolean);
const CONTACT_FROM = process.env.CONTACT_FROM || 'Heirstone Consulting Website <website@heirstoneconsulting.com>';
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/;
const recent = new Map(); // ip -> timestamps of recent enquiries

function rateLimited(ip) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  list.push(now);
  recent.set(ip, list);
  if (recent.size > 5000) recent.clear();
  return list.length > 5; // more than 5 enquiries in 10 minutes from one address
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Any Resend API call. RESEND_API_URL overrides the host (local tests point it at a mock).
const RESEND_API = new URL(process.env.RESEND_API_URL || 'https://api.resend.com');
function resendApi(method, apiPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'User-Agent': 'heirstone-website' };
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = (RESEND_API.protocol === 'http:' ? http : https).request({
      hostname: RESEND_API.hostname, port: RESEND_API.port || undefined, path: apiPath, method, timeout: 10000, headers,
    }, r => {
      let out = '';
      r.on('data', d => { out += d; });
      r.on('end', () => resolve({ status: r.statusCode, body: out }));
    });
    req.on('timeout', () => req.destroy(new Error('Resend timed out')));
    req.on('error', reject);
    req.end(body || undefined);
  });
}
const resendSend = (payload) => resendApi('POST', '/emails', payload);

function handleContact(req, res) {
  const json = (status, obj) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(obj));
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method' });

  let raw = '';
  let tooBig = false;
  req.on('data', chunk => {
    if (tooBig) return; // keep draining, ignore the rest
    raw += chunk;
    if (raw.length > 32 * 1024) { tooBig = true; raw = ''; json(413, { ok: false, error: 'too_large' }); }
  });
  req.on('end', async () => {
    if (tooBig) return;
    let d;
    try { d = JSON.parse(raw || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad_json' }); }
    const field = (k, max) => String(d[k] == null ? '' : d[k]).trim().slice(0, max);
    const name = field('name', 200), email = field('email', 254), subject = field('_subject', 300);
    const message = field('message', 10000), page = field('page', 300), lang = field('lang', 20);

    if (field('_honey', 200)) return json(200, { ok: true }); // bot filled the hidden field: pretend success
    if (!name || !message || !EMAIL_RE.test(email)) return json(400, { ok: false, error: 'invalid' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (rateLimited(ip)) return json(429, { ok: false, error: 'rate_limited' });
    if (!process.env.RESEND_API_KEY) return json(503, { ok: false, fallback: true });

    const rows = [['Name', name], ['Email', email], ['Subject', subject || '—'], ['Page', page || '—'], ['Language', lang || 'en']];
    const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2430">'
      + '<h2 style="font-size:18px;margin:0 0 16px">New website enquiry</h2>'
      + '<table cellpadding="6" style="border-collapse:collapse">'
      + rows.map(([k, v]) => `<tr><td style="color:#6b7480;vertical-align:top">${k}</td><td>${esc(v)}</td></tr>`).join('')
      + '</table>'
      + `<p style="margin:20px 0 6px;color:#6b7480">Message</p><div style="white-space:pre-wrap;border-left:3px solid #8aa4c8;padding:8px 14px">${esc(message)}</div>`
      + '<p style="margin-top:24px;color:#9aa2ad;font-size:12px">Reply to this email to answer the sender directly.</p></div>';
    const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n' + message;

    try {
      const r = await resendSend({
        from: CONTACT_FROM,
        to: CONTACT_TO,
        reply_to: email,
        subject: 'Website enquiry: ' + (subject || name),
        html,
        text,
      });
      if (r.status >= 200 && r.status < 300) return json(200, { ok: true });
      console.error('Resend error', r.status, r.body.slice(0, 300));
    } catch (e) {
      console.error('Resend request failed', e.message);
    }
    json(502, { ok: false, fallback: true });
  });
}

// ------------------------------------------------------------------ research reports (email-gated)
// POST /api/reports/request  emails the visitor a personal, signed, expiring download link
//                            (so the report only reaches a real inbox), records the lead, adds the
//                            visitor to the newsletter list and notifies CONTACT_TO.
// GET  /api/reports/download?t=…  streams the PDF from private/reports (never served statically) and
//                            tells CONTACT_TO the first time each person downloads each edition.
// GET  /api/reports/leads.csv?k=…  owner export; the link with its key is in every lead notification.
// Leads are appended to $LEADS_DIR/report-leads.jsonl (mount a Railway volume there to keep them
// across deploys) and also written to the server log as REPORT_LEAD lines.
const crypto = require('crypto');
const REPORTS_DIR = path.join(ROOT, 'private', 'reports');
let REPORTS = {};
try { REPORTS = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, 'catalog.json'), 'utf8')); }
catch (e) { console.error('Reports catalog missing:', e.message); }
// Edition of a report in the requested language (catalog: editions.en / editions.fr), falling back to English.
const edition = (r, l) => (r.editions && (r.editions[l] || r.editions.en)) || r;
const editionLang = (r, l) => (r.editions && r.editions[l] ? l : 'en');
const LEADS_DIR = process.env.LEADS_DIR || path.join(ROOT, 'data');
const LEADS_FILE = path.join(LEADS_DIR, 'report-leads.jsonl');
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://www.heirstoneconsulting.com';
const REPORT_FROM = process.env.REPORT_FROM || 'Heirstone Consulting Research <research@heirstoneconsulting.com>';
const LINK_DAYS = 14;

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const reportKey = () => crypto.createHash('sha256').update('hs-reports|' + (process.env.REPORTS_SECRET || process.env.RESEND_API_KEY || '')).digest();
const sign = (s) => b64u(crypto.createHmac('sha256', reportKey()).update(s).digest()).slice(0, 32);
const makeToken = (obj) => { const p = b64u(JSON.stringify(obj)); return p + '.' + sign(p); };
function readToken(t) {
  const [p, s] = String(t || '').split('.');
  if (!p || !s) return null;
  const want = sign(p);
  if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
  try {
    const o = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return o && o.x > Date.now() ? o : null;
  } catch (e) { return null; }
}
const exportKey = () => sign('leads-export');

function saveLead(rec) {
  console.log('REPORT_LEAD ' + JSON.stringify(rec));
  try { fs.mkdirSync(LEADS_DIR, { recursive: true }); fs.appendFileSync(LEADS_FILE, JSON.stringify(rec) + '\n'); }
  catch (e) { console.error('Lead not written to disk:', e.message); }
}

// ------------------------------------------------------------------ newsletter list (Resend contacts)
// The report form's consent box reads "I agree to receive this report and occasional Heirstone research
// by email", so every requester joins the newsletter list: a Resend contact in the newsletter segment,
// opted in to the English or French topic to match the edition they chose. Existing contacts keep their
// preferences, and anyone who has unsubscribed is never re-added. IDs come from newsletter/config.json
// (env NEWSLETTER_SEGMENT_ID / NEWSLETTER_TOPIC_EN / NEWSLETTER_TOPIC_FR override); no segment = step off.
let NEWSLETTER = {};
try { NEWSLETTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'newsletter', 'config.json'), 'utf8')); }
catch (e) { console.error('Newsletter config missing:', e.message); }
const nlIds = NEWSLETTER.resend || {};
const NL_SEGMENT = /^off$/i.test(process.env.NEWSLETTER_SEGMENT_ID || '') ? '' : (process.env.NEWSLETTER_SEGMENT_ID || nlIds.segment_id || ''); // 'off' pauses sign-ups
const NL_TOPICS = {
  en: process.env.NEWSLETTER_TOPIC_EN || (nlIds.topics || {}).en || '',
  fr: process.env.NEWSLETTER_TOPIC_FR || (nlIds.topics || {}).fr || '',
};
const nlName = (l) => ((NEWSLETTER.name || {})[l] || (NEWSLETTER.name || {}).en || 'the Heirstone newsletter');

async function subscribeToNewsletter({ email, name, org, l, siteLang, slug, ts }) {
  if (!NL_SEGMENT || !process.env.RESEND_API_KEY) return { status: 'off' };
  const who = encodeURIComponent(email);
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));
  const latest = { last_report: slug, last_report_at: ts };
  try {
    const found = await resendApi('GET', `/contacts/${who}`);
    if (found.status === 200) {
      const c = JSON.parse(found.body || '{}');
      if (c.unsubscribed) return { status: 'unsubscribed' };
      const upd = await resendApi('PATCH', `/contacts/${who}`, { properties: latest });
      if (upd.status >= 300) console.error('Newsletter: contact update failed', upd.status, upd.body.slice(0, 200));
      const seg = await resendApi('POST', `/contacts/${who}/segments/${NL_SEGMENT}`);
      if (seg.status >= 300) console.error('Newsletter: add to segment returned', seg.status, seg.body.slice(0, 200));
      return { status: 'existing' };
    }
    if (found.status !== 404) return { status: 'error', detail: `lookup returned ${found.status}` };

    const [first, ...rest] = name.split(/\s+/);
    const contact = {
      email, first_name: first || '', last_name: rest.join(' '), unsubscribed: false,
      segments: [{ id: NL_SEGMENT }],
      topics: ['en', 'fr'].filter((k) => NL_TOPICS[k]).map((k) => ({ id: NL_TOPICS[k], subscription: k === l ? 'opt_in' : 'opt_out' })),
      properties: clean({ organisation: org, language: l, site_language: siteLang, source: 'report-request', first_report: slug, signed_up_at: ts, ...latest }),
    };
    let made = await resendApi('POST', '/contacts', contact);
    if (made.status >= 400 && made.status < 500 && /propert/i.test(made.body)) {
      // A property key isn't set up in Resend: keep the subscriber, drop the extra fields
      console.error('Newsletter: properties rejected, adding the contact without them:', made.body.slice(0, 200));
      delete contact.properties;
      made = await resendApi('POST', '/contacts', contact);
    }
    if (made.status >= 200 && made.status < 300) return { status: 'added' };
    return { status: 'error', detail: `create returned ${made.status} ${made.body.slice(0, 160)}` };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

// ------------------------------------------------------------------ owner notifications
// Times are shown in NOTIFY_TZ (default Cairo). NOTIFY_DOWNLOADS=off turns the download alerts off.
const NOTIFY_TZ = process.env.NOTIFY_TZ || 'Africa/Cairo';
const NOTIFY_DOWNLOADS = !/^(0|off|false|no)$/i.test(process.env.NOTIFY_DOWNLOADS || '');
function when(ms) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: NOTIFY_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const city = NOTIFY_TZ.split('/').pop().replace(/_/g, ' ');
    return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${city} time (${p.timeZoneName})`;
  } catch (e) {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}
function langName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch (e) { return code; }
}
// Where a lead came from, from the campaign tags the report form passes along with the page path
function cameFrom(page) {
  const q = new URLSearchParams(String(page).split('?')[1] || '');
  const src = q.get('utm_source');
  if (!src) return 'No campaign tag (search, direct visit or a shared link)';
  if (src === 'newsletter') return `Newsletter: ${q.get('utm_campaign') || 'issue unknown'}`;
  return [src, q.get('utm_medium'), q.get('utm_campaign')].filter(Boolean).join(' / ');
}
const NL_STATUS = {
  added: (l) => `Added to the newsletter list (${langName(l)} edition)`,
  existing: () => 'Already on the newsletter list',
  unsubscribed: () => 'Unsubscribed earlier, so not re-added',
  off: () => 'Not added: the newsletter list is not set up yet',
  error: (l, d) => `Not added (${d}). Add them by hand in Resend`,
};

function notifyOwner({ subject, heading, rows, note, replyTo }) {
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2430">'
    + `<h2 style="font-size:18px;margin:0 0 16px">${esc(heading)}</h2>`
    + '<table cellpadding="6" style="border-collapse:collapse">'
    + rows.map(([k, v]) => `<tr><td style="color:#6b7480;vertical-align:top;white-space:nowrap">${k}</td><td>${esc(v)}</td></tr>`).join('')
    + '</table>' + (note ? `<p style="margin-top:18px;color:#6b7480">${note.html}</p>` : '') + '</div>';
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (note ? `\n\n${note.text}` : '');
  return resendSend({ from: CONTACT_FROM, to: CONTACT_TO, reply_to: replyTo, subject, html, text })
    .then((r) => { if (r.status >= 300) console.error('Owner notification failed', r.status, r.body.slice(0, 200)); })
    .catch((e) => console.error('Owner notification failed', e.message));
}

// Corporate mail filters (Mimecast, Proofpoint, Defender…) often open links seconds after delivery.
// Opens that quick are logged but don't trigger an alert, so the alert reflects a person clicking.
const SCAN_WINDOW_MS = 20 * 1000;
const alerted = new Map();
function notifyDownload(tok, r, el, ua) {
  const now = Date.now();
  const requested = tok.x - LINK_DAYS * 864e5;
  const scan = now - requested < SCAN_WINDOW_MS || BOTS.test(ua || '');
  saveLead({ ts: new Date(now).toISOString(), event: 'download', email: tok.e, report: tok.r, edition: el, ...(scan ? { likely_scan: true } : {}) });
  const key = `${tok.e}|${tok.r}|${el}`;
  if (scan || !NOTIFY_DOWNLOADS || alerted.has(key)) return;
  if (alerted.size > 5000) alerted.clear();
  alerted.set(key, now);
  const title = `${r.sector}: ${r.title}`;
  notifyOwner({
    subject: `Report downloaded: ${r.sector} (${langName(el)}) — ${tok.n || tok.e}`,
    heading: 'Report downloaded',
    rows: [['Name', tok.n || '—'], ['Email', tok.e], ['Report', title], ['Language', `${langName(el)} edition`],
      ['Downloaded', when(now)], ['Link sent', when(requested)]],
    replyTo: tok.e,
  });
}

function readJsonBody(req, res, json, done) {
  let raw = '', tooBig = false;
  req.on('data', chunk => {
    if (tooBig) return;
    raw += chunk;
    if (raw.length > 32 * 1024) { tooBig = true; raw = ''; json(413, { ok: false, error: 'too_large' }); }
  });
  req.on('end', () => {
    if (tooBig) return;
    let d;
    try { d = JSON.parse(raw || '{}'); } catch (e) { return json(400, { ok: false, error: 'bad_json' }); }
    done(d);
  });
}

const MAIL_TEXT = {
  en: { dear: 'Dear', ready: 'Thank you for your interest. Your copy of our report is ready:', button: 'Download the report (PDF)',
    valid: (d) => `This personal link is valid for ${d} days. If the button does not work, copy this address into your browser:`,
    other: 'This report is also available in French:', otherLink: 'Download the French edition (PDF)',
    discuss: 'If you would like to discuss the findings, simply reply to this email.',
    why: 'You received this email because this address was entered to request a Heirstone report. To stop receiving Heirstone research, reply with "unsubscribe".',
    whyNl: (n) => `You received this email because this address was entered to request a Heirstone report. As agreed on the form, we will also send you ${n}, our research newsletter on new reports and findings. Every issue has a one-click unsubscribe link, or reply "unsubscribe" at any time.`,
    subject: 'Your Heirstone report' },
  fr: { dear: 'Bonjour', ready: 'Merci de votre intérêt. Votre exemplaire de notre rapport est prêt :', button: 'Télécharger le rapport (PDF)',
    valid: (d) => `Ce lien personnel est valable ${d} jours. Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :`,
    other: 'Ce rapport est également disponible en anglais :', otherLink: 'Télécharger l’édition anglaise (PDF)',
    discuss: 'Pour échanger sur les conclusions, il vous suffit de répondre à cet e-mail.',
    why: 'Vous recevez cet e-mail car cette adresse a été saisie pour demander un rapport Heirstone. Pour ne plus recevoir nos publications, répondez « désinscription ».',
    whyNl: (n) => `Vous recevez cet e-mail car cette adresse a été saisie pour demander un rapport Heirstone. Comme convenu dans le formulaire, nous vous enverrons aussi ${n}, notre lettre de recherche sur nos nouveaux rapports et résultats. Chaque numéro comporte un lien de désinscription en un clic ; vous pouvez aussi répondre « désinscription » à tout moment.`,
    subject: 'Votre rapport Heirstone' },
};

function reportEmail(r, name, link, l, otherLink) {
  const t = MAIL_TEXT[l] || MAIL_TEXT.en;
  const why = NL_SEGMENT ? t.whyNl(nlName(l)) : t.why;
  const ed = edition(r, l);
  const sep = l === 'fr' ? ' : ' : ': ';  // French puts a space before the colon
  const title = `${ed.sector || r.sector}${sep}${ed.title || r.title}`;
  const first = esc(name.split(/\s+/)[0]);
  const html = '<div style="background:#F6F4EF;padding:32px 0;font-family:Arial,Helvetica,sans-serif;color:#263340">'
    + '<div style="max-width:560px;margin:0 auto;background:#FCFBF8;border:1px solid #E4DED2">'
    + '<div style="background:#0E1B2A;padding:22px 32px;color:#fff;font-size:13px;letter-spacing:4px">HEIRSTONE CONSULTING RESEARCH</div>'
    + '<div style="padding:32px">'
    + `<p style="font-size:15px;line-height:1.6;margin:0 0 16px">${t.dear} ${first},</p>`
    + `<p style="font-size:15px;line-height:1.6;margin:0 0 8px">${esc(t.ready)}</p>`
    + `<p style="font-family:Georgia,serif;font-size:22px;line-height:1.3;color:#0E1B2A;margin:16px 0 24px">${esc(title)}</p>`
    + `<p style="margin:0 0 26px"><a href="${link}" style="display:inline-block;background:#0E1B2A;color:#fff;text-decoration:none;padding:14px 26px;font-size:14px;font-weight:bold">${esc(t.button)}</a></p>`
    + `<p style="font-size:13px;line-height:1.6;color:#6E7F92;margin:0 0 20px">${esc(t.valid(LINK_DAYS))}<br><span style="word-break:break-all">${link}</span></p>`
    + (otherLink ? `<p style="font-size:14px;line-height:1.6;margin:0 0 22px">${esc(t.other)} <a href="${otherLink}" style="color:#0E1B2A;font-weight:bold">${esc(t.otherLink)}</a></p>` : '')
    + `<p style="font-size:15px;line-height:1.6;margin:0 0 6px">${esc(t.discuss)}</p>`
    + '<p style="font-size:15px;line-height:1.6;margin:0">Heirstone Consulting<br><span style="color:#6E7F92">Dubai &middot; Cairo &middot; <a href="https://www.heirstoneconsulting.com" style="color:#5D6E82">heirstoneconsulting.com</a></span></p>'
    + '</div></div>'
    + '<p style="max-width:560px;margin:14px auto 0;font-size:11px;line-height:1.5;color:#97A6B6;text-align:center">' + esc(why) + '</p>'
    + '</div>';
  const text = `${t.dear} ${name.split(/\s+/)[0]},\n\n${t.ready}\n${title}\n\n${t.button}: ${link}\n${t.valid(LINK_DAYS)}\n`
    + (otherLink ? `\n${t.other} ${otherLink}\n` : '')
    + `\n${t.discuss}\n\nHeirstone Consulting\nDubai · Cairo · heirstoneconsulting.com\n\n${why}`;
  return { title, html, text, subject: `${t.subject}${sep}${title}` };
}

function handleReportRequest(req, res) {
  const json = (status, obj) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(obj));
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method' });
  readJsonBody(req, res, json, async (d) => {
    const field = (k, max) => String(d[k] == null ? '' : d[k]).trim().slice(0, max);
    const name = field('name', 200), email = field('email', 254).toLowerCase(), org = field('org', 200);
    const slug = field('report', 80), lang = field('lang', 20), page = field('page', 300);
    if (field('_honey', 200)) return json(200, { ok: true }); // bot filled the hidden field
    const r = REPORTS[slug];
    if (!name || !EMAIL_RE.test(email) || d.consent !== true || !r) return json(400, { ok: false, error: 'invalid' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (rateLimited('report:' + ip)) return json(429, { ok: false, error: 'rate_limited' });
    if (!process.env.RESEND_API_KEY) return json(503, { ok: false, error: 'unavailable' });

    const l = editionLang(r, field('edition', 5));
    const exp = Date.now() + LINK_DAYS * 864e5;
    const linkFor = (ll) => `${PUBLIC_ORIGIN}/api/reports/download?t=${makeToken({ r: slug, e: email, n: name.slice(0, 80), l: ll, x: exp })}`;
    const link = linkFor(l);
    const other = r.editions && Object.keys(r.editions).find((k) => k !== l);
    const mail = reportEmail(r, name, link, l, other ? linkFor(other) : '');
    try {
      const sent = await resendSend({ from: REPORT_FROM, to: [email], reply_to: CONTACT_TO[0], subject: mail.subject, html: mail.html, text: mail.text });
      if (sent.status < 200 || sent.status >= 300) {
        console.error('Report email failed', sent.status, sent.body.slice(0, 300));
        return json(502, { ok: false, error: 'send_failed' });
      }
    } catch (e) {
      console.error('Report email request failed', e.message);
      return json(502, { ok: false, error: 'send_failed' });
    }

    const now = Date.now(), ts = new Date(now).toISOString();
    saveLead({ ts, event: 'request', name, email, org, report: slug, edition: l, lang, page });
    json(200, { ok: true });

    // After replying: add them to the newsletter list, then tell the owner (with the list outcome)
    const nl = await subscribeToNewsletter({ email, name, org, l, siteLang: lang || 'en', slug, ts });
    console.log(`NEWSLETTER ${nl.status} ${email}${nl.detail ? ' ' + nl.detail : ''}`);
    const exportLink = `${PUBLIC_ORIGIN}/api/reports/leads.csv?k=${exportKey()}`;
    const site = (lang || 'en').slice(0, 2);
    const sent = 'The report link was emailed to the visitor' + (NOTIFY_DOWNLOADS ? '; you will get a second email when they download it.' : '.');
    notifyOwner({
      subject: `Report request: ${r.sector} (${langName(l)}) — ${name}${org ? ' (' + org + ')' : ''}`,
      heading: 'New report request',
      rows: [['Name', name], ['Email', email], ['Organisation', org || '—'], ['Report', `${r.sector}: ${r.title}`], ['Language', `${langName(l)} edition`],
        ['Requested', when(now)], ['Newsletter', NL_STATUS[nl.status](l, nl.detail)], ['Came from', cameFrom(page)], ['Page', page.split('?')[0] || '—'], ['Site language', `${langName(site)} (${site})`]],
      note: {
        html: `${sent} <a href="${exportLink}">Download all report leads (CSV)</a> &mdash; keep this link private.`,
        text: `${sent}\nAll report leads (CSV, keep private): ${exportLink}`,
      },
      replyTo: email,
    });
  });
}

function reportLinkPage(res, status) {
  const body = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link expired | Heirstone Consulting</title></head>'
    + '<body style="margin:0;font-family:Arial,sans-serif;background:#F6F4EF;color:#263340"><div style="max-width:520px;margin:12vh auto;padding:40px;background:#FCFBF8;border:1px solid #E4DED2">'
    + '<p style="letter-spacing:4px;font-size:12px;color:#5D6E82">HEIRSTONE CONSULTING RESEARCH</p><h1 style="font-family:Georgia,serif;font-weight:normal;color:#0E1B2A">This download link has expired</h1>'
    + `<p style="line-height:1.7">Personal report links are valid for ${LINK_DAYS} days. Request a new one and we will email it to you straight away.</p>`
    + '<p><a href="/pages/reports" style="display:inline-block;background:#0E1B2A;color:#fff;text-decoration:none;padding:12px 22px">Go to Reports</a></p></div></body></html>';
  send(res, status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }, body);
}

function handleReportDownload(req, res, qs) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {}, 'Method not allowed');
  const tok = readToken(new URLSearchParams(qs).get('t'));
  const r = tok && REPORTS[tok.r];
  if (!r) return reportLinkPage(res, 410);
  const ed = edition(r, tok.l || 'en');
  const file = path.join(REPORTS_DIR, path.basename(ed.file));
  fs.stat(file, (err, st) => {
    if (err) { console.error('Report file missing', file); return reportLinkPage(res, 404); }
    const name = ed.download_name || path.basename(ed.file);
    res.writeHead(200, {
      'Content-Type': 'application/pdf', 'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex',
    });
    if (req.method === 'HEAD') return res.end();
    if (!req.headers.range) notifyDownload(tok, r, editionLang(r, tok.l || 'en'), req.headers['user-agent']);
    fs.createReadStream(file).pipe(res);
  });
}

function handleLeadsExport(req, res, qs) {
  const k = String(new URLSearchParams(qs).get('k') || '');
  const want = exportKey();
  if (!process.env.RESEND_API_KEY || k.length !== want.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) {
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  }
  let lines = [];
  try { lines = fs.readFileSync(LEADS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
  const cols = ['ts', 'event', 'name', 'email', 'org', 'report', 'edition', 'lang', 'page', 'likely_scan'];
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = '﻿' + ['time,event,name,email,organisation,report,edition,site language,page,mail-filter scan'].concat(lines.map((o) => cols.map((c) => cell(o[c])).join(','))).join('\r\n');
  send(res, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="heirstone-report-leads.csv"', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }, csv);
}

const server = http.createServer((req, res) => {
  // Redirect non-www to www
  const host = req.headers.host || '';
  if (host && !host.startsWith('www.') && !host.startsWith('localhost') && !host.startsWith('127.')) {
    return send(res, 301, { 'Location': 'https://www.' + host + req.url });
  }

  const route = req.url.split('?')[0];
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  if (route === '/api/contact') return handleContact(req, res);
  if (route === '/api/reports/request') return handleReportRequest(req, res);
  if (route === '/api/reports/download') return handleReportDownload(req, res, query);
  if (route === '/api/reports/leads.csv') return handleLeadsExport(req, res, query);

  let urlPath = req.url.split('?')[0]; // strip query strings
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  try { urlPath = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, {}, 'Bad request'); }

  // Gated PDFs, collected leads and newsletter tooling are never served as static files
  if (/^\/+(private|data|newsletter)(\/|$)/i.test(urlPath)) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');

  // Canonicalise to clean URLs: redirect *.html and /index to extensionless paths
  if (/\.html$/i.test(urlPath)) {
    let clean = urlPath.replace(/\.html$/i, '');
    if (/(^|\/)index$/.test(clean)) clean = clean.replace(/index$/, '');
    return send(res, 301, { 'Location': (clean || '/') + qs });
  }
  if (/(^|\/)index$/.test(urlPath)) {
    return send(res, 301, { 'Location': urlPath.replace(/index$/, '') + qs });
  }

  // Language prefix: /es -> /es/
  const first = urlPath.split('/')[1] || '';
  const lang = LANGS.includes(first) ? first : null;
  if (lang && urlPath === '/' + lang) {
    return send(res, 301, { 'Location': '/' + lang + '/' + qs });
  }

  // Device-language detection for English (unprefixed) pages.
  // An explicit choice from the switcher (hs_lang cookie) always wins; crawlers always get English.
  const isPage = !path.extname(urlPath);
  if (!lang && isPage && req.method === 'GET' && !BOTS.test(req.headers['user-agent'] || '')) {
    const chosen = cookie(req, 'hs_lang');
    const target = chosen && SUPPORTED.has(chosen) ? chosen : preferredLanguage(req.headers['accept-language']);
    if (target && target !== 'en') {
      return send(res, 302, {
        'Location': '/' + target + (urlPath === '/' ? '/' : urlPath) + qs,
        'Vary': 'Accept-Language, Cookie',
        'Cache-Control': 'private, no-store',
      });
    }
  }

  // Map the URL to a file
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  let filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    return send(res, 403, {}, 'Forbidden');
  }
  const rel = path.relative(ROOT, filePath).split(path.sep)[0].toLowerCase();
  if (rel === 'private' || rel === 'data' || rel === 'newsletter') return send(res, 404, {}, 'Not found');
  if (!path.extname(filePath)) filePath += '.html';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const notFound = path.join(ROOT, lang ? lang : '', '404.html');
      fs.readFile(notFound, (err2, data2) => {
        if (err2) {
          fs.readFile(path.join(ROOT, '404.html'), (err3, data3) => {
            send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, err3 ? '<h1>404 - Page Not Found</h1>' : withAnalytics(req, data3));
          });
        } else {
          send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, withAnalytics(req, data2));
        }
      });
      return;
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Vary'] = 'Accept-Language, Cookie';
    send(res, 200, headers, ext === '.html' ? withAnalytics(req, data) : data);
  });
});

server.listen(PORT, () => {
  console.log(`Heirstone server running on port ${PORT}`);
});

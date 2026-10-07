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
const LANGS = ['ar', 'zh', 'ja', 'es', 'fr', 'it', 'pt', 'el', 'de', 'fi', 'da', 'ro', 'sw', 'ru', 'ky', 'kk', 'tr'];
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
    return { base: tag.trim().toLowerCase().split('-')[0], q: q ? parseFloat(q.slice(2)) || 0 : 1, i };
  }).filter(t => t.base && t.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  const hit = tags.find(t => SUPPORTED.has(t.base));
  return hit ? hit.base : null;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
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

function resendSend(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST', timeout: 10000,
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, r => {
      let out = '';
      r.on('data', d => { out += d; });
      r.on('end', () => resolve({ status: r.statusCode, body: out }));
    });
    req.on('timeout', () => req.destroy(new Error('Resend timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

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
//                            (so the report only reaches a real inbox), records the lead and
//                            notifies CONTACT_TO.
// GET  /api/reports/download?t=…  streams the PDF from private/reports (never served statically).
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
    subject: 'Your Heirstone report' },
  fr: { dear: 'Bonjour', ready: 'Merci de votre intérêt. Votre exemplaire de notre rapport est prêt :', button: 'Télécharger le rapport (PDF)',
    valid: (d) => `Ce lien personnel est valable ${d} jours. Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :`,
    other: 'Ce rapport est également disponible en anglais :', otherLink: 'Télécharger l’édition anglaise (PDF)',
    discuss: 'Pour échanger sur les conclusions, il vous suffit de répondre à cet e-mail.',
    why: 'Vous recevez cet e-mail car cette adresse a été saisie pour demander un rapport Heirstone. Pour ne plus recevoir nos publications, répondez « désinscription ».',
    subject: 'Votre rapport Heirstone' },
};

function reportEmail(r, name, link, l, otherLink) {
  const t = MAIL_TEXT[l] || MAIL_TEXT.en;
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
    + '<p style="max-width:560px;margin:14px auto 0;font-size:11px;line-height:1.5;color:#97A6B6;text-align:center">' + esc(t.why) + '</p>'
    + '</div>';
  const text = `${t.dear} ${name.split(/\s+/)[0]},\n\n${t.ready}\n${title}\n\n${t.button}: ${link}\n${t.valid(LINK_DAYS)}\n`
    + (otherLink ? `\n${t.other} ${otherLink}\n` : '')
    + `\n${t.discuss}\n\nHeirstone Consulting\nDubai · Cairo · heirstoneconsulting.com\n\n${t.why}`;
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
    const linkFor = (ll) => `${PUBLIC_ORIGIN}/api/reports/download?t=${makeToken({ r: slug, e: email, l: ll, x: exp })}`;
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

    saveLead({ ts: new Date().toISOString(), event: 'request', name, email, org, report: slug, edition: l, lang, page });
    const rows = [['Name', name], ['Email', email], ['Organisation', org || '—'], ['Report', mail.title], ['Edition', l === 'fr' ? 'French' : 'English'], ['Page', page || '—'], ['Site language', lang || 'en']];
    const exportLink = `${PUBLIC_ORIGIN}/api/reports/leads.csv?k=${exportKey()}`;
    resendSend({
      from: CONTACT_FROM, to: CONTACT_TO, reply_to: email,
      subject: `Report request: ${r.sector} — ${name}${org ? ' (' + org + ')' : ''}`,
      html: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b2430"><h2 style="font-size:18px;margin:0 0 16px">New report request</h2>'
        + '<table cellpadding="6" style="border-collapse:collapse">' + rows.map(([k, v]) => `<tr><td style="color:#6b7480">${k}</td><td>${esc(v)}</td></tr>`).join('') + '</table>'
        + `<p style="margin-top:18px;color:#6b7480">The report was emailed to the visitor. <a href="${exportLink}">Download all report leads (CSV)</a> &mdash; keep this link private.</p></div>`,
      text: rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nAll report leads (CSV, keep private): ${exportLink}`,
    }).catch((e) => console.error('Lead notification failed', e.message));
    json(200, { ok: true });
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
    if (!req.headers.range) saveLead({ ts: new Date().toISOString(), event: 'download', email: tok.e, report: tok.r, edition: editionLang(r, tok.l || 'en') });
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
  const cols = ['ts', 'event', 'name', 'email', 'org', 'report', 'edition', 'lang', 'page'];
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = '﻿' + ['time,event,name,email,organisation,report,edition,site language,page'].concat(lines.map((o) => cols.map((c) => cell(o[c])).join(','))).join('\r\n');
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

  // Gated PDFs and collected leads are never served as static files
  if (/^\/+(private|data)(\/|$)/i.test(urlPath)) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');

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
  if (rel === 'private' || rel === 'data') return send(res, 404, {}, 'Not found');
  if (!path.extname(filePath)) filePath += '.html';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const notFound = path.join(ROOT, lang ? lang : '', '404.html');
      fs.readFile(notFound, (err2, data2) => {
        if (err2) {
          fs.readFile(path.join(ROOT, '404.html'), (err3, data3) => {
            send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, err3 ? '<h1>404 - Page Not Found</h1>' : data3);
          });
        } else {
          send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, data2);
        }
      });
      return;
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Vary'] = 'Accept-Language, Cookie';
    send(res, 200, headers, data);
  });
});

server.listen(PORT, () => {
  console.log(`Heirstone server running on port ${PORT}`);
});

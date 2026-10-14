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
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
};

// Translated editions live under /<code>/. English is the root.
const LANGS = ['ar', 'zh', 'ja', 'ko', 'id', 'ms', 'es', 'fr', 'it', 'pt', 'el', 'de', 'nl', 'fi', 'da', 'no', 'ro', 'pl', 'sk', 'hr', 'sw', 'ru', 'ky', 'kk', 'tr'];
// Browser codes that map onto one of our folders: legacy Indonesian, Norwegian Bokmål and Nynorsk
const LANG_ALIAS = { in: 'id', nb: 'no', nn: 'no' };
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
    return { base: LANG_ALIAS[base] || base, q: q ? parseFloat(q.slice(2)) || 0 : 1, i };
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

// ------------------------------------------------------------------ speed: compression, caching, minified assets
// Text responses are compressed (Brotli, else gzip) when the browser accepts it. CSS and JS are served
// from min/ (built by tools/minify.js) while a copy matches its source, else from the readable source.
// Pages link them as style.css?v=<hash of the source>, so browsers can keep them for a year and still
// fetch the new file as soon as a deploy changes it.
const zlib = require('zlib');
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.xml', '.txt', '.ico']);
const ASSETS = new Map(); // '/css/style.css' -> { body, br, gz, v, mtime }
const BROTLI_FAST = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } };
const STATIC_CACHE = { '.webp': 604800, '.jpg': 604800, '.jpeg': 604800, '.png': 604800, '.gif': 604800, '.svg': 604800,
  '.ico': 604800, '.woff': 2592000, '.woff2': 2592000, '.mp4': 604800, '.pdf': 86400, '.xml': 3600, '.txt': 3600 };

function asset(route) {
  const m = route.match(/^\/(css|js)\/([\w.-]+\.(?:css|js))$/);
  if (!m || !route.endsWith('.' + m[1])) return null;
  const src = path.join(ROOT, m[1], m[2]);
  let st;
  try { st = fs.statSync(src); } catch (e) { return null; }
  const cached = ASSETS.get(route);
  if (cached && cached.mtime === st.mtimeMs) return cached;
  const text = fs.readFileSync(src, 'utf8');
  const v = require('crypto').createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12); // same hash on Windows checkouts
  let body = text;
  try {
    const min = fs.readFileSync(path.join(ROOT, 'min', m[1], m[2]), 'utf8');
    if (min.startsWith(`/*! src:${v} */`)) body = min;
  } catch (e) {}
  const buf = Buffer.from(body);
  const a = { body: buf, v, mtime: st.mtimeMs, min: body !== text,
    br: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }), gz: zlib.gzipSync(buf, { level: 9 }) };
  ASSETS.set(route, a);
  return a;
}
for (const dir of ['css', 'js']) {
  try { fs.readdirSync(path.join(ROOT, dir)).forEach((f) => asset(`/${dir}/${f}`)); } catch (e) {}
}

// href="../css/style.css" -> href="../css/style.css?v=0d9eac52978d"
function versionAssets(html) {
  return html.replace(/(["'])((?:\.\.\/)*\/?)(css|js)\/([\w.-]+\.(?:css|js))(?=["'])/g, (m, q, pre, dir, name) => {
    const a = asset(`/${dir}/${name}`);
    return a ? `${q}${pre}${dir}/${name}?v=${a.v}` : m;
  });
}

function acceptedEncoding(req) {
  const ok = {};
  String(req.headers['accept-encoding'] || '').split(',').forEach((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='));
    if (!q || parseFloat(q.slice(2)) > 0) ok[name] = true;
  });
  return ok.br ? 'br' : ok.gzip ? 'gzip' : null;
}

// Send a text body compressed when it is worth it (always sets Content-Length)
function sendText(req, res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  headers['Vary'] = headers['Vary'] ? headers['Vary'] + ', Accept-Encoding' : 'Accept-Encoding';
  const enc = buf.length >= 1024 ? acceptedEncoding(req) : null;
  const finish = (out, used) => {
    if (used) headers['Content-Encoding'] = used;
    headers['Content-Length'] = out.length;
    send(res, status, headers, out);
  };
  if (!enc) return finish(buf);
  const cb = (err, out) => (err ? finish(buf) : finish(out, enc));
  if (enc === 'br') zlib.brotliCompress(buf, BROTLI_FAST, cb); else zlib.gzip(buf, { level: 6 }, cb);
}

// The page as served: analytics beacon (production only) and versioned CSS/JS links
const renderPage = (req, html) => versionAssets(withAnalytics(req, html).toString('utf8'));

// ------------------------------------------------------------------ addresses from the earlier site
// The first version of the site used /services/<long-name>. Google still requests those (Search Console
// lists them as 404s), so each one is sent permanently to today's page; any other /services address goes to
// the same-named page if there is one, else to the Services overview.
const LEGACY_SERVICES = {
  'competitive-benchmarking': 'competitive-benchmarking',
  'public-private-partnership-strategy': 'ppp-strategy',
  'global-benchmarking-of-national-transformation-programs': 'global-benchmarking',
  'global-benchmarking-of-tourism-models': 'global-benchmarking',
  'national-visions-and-strategic-frameworks': 'national-vision',
  'cross-border-expansion-advisory': 'cross-border-expansion',
  'innovation-ecosystem-strategy': 'innovation-ecosystem',
  'market-research-and-opportunity-identification': 'market-research',
  'cultural-heritage-and-eco-tourism-development-strategy': 'tourism-development',
  'branded-residences-strategy-advisory': 'branded-residences',
  'tourism-market-research-and-demand-forecasting': 'tourism-market-research',
  'tourism-policy-and-investment-strategy-advisory': 'policy-framework',
  'large-scale-asset-monetization-strategy': 'asset-monetization',
  'monitoring-and-adjustment-frameworks': 'monitoring-frameworks',
  'highest-and-best-use-analysis': 'highest-and-best-use',
  'flagship-project-and-anchor-asset-strategy': 'special-projects',
  'visitor-economy-strategy': 'visitor-economy',
  'destination-brand-development-advisory': 'destination-brand',
  'development-strategy-and-phasing': 'development-strategy',
  'destination-strategy-and-positioning': 'destination-strategy',
  'sports-culture-and-mega-event-strategy-advisory': 'sports-culture',
  'commercial-feasibility-studies': 'commercial-feasibility',
  'investor-outreach-strategy-and-phased-engagement-planning': 'investor-outreach',
  'investment-attraction-strategy': 'investment-attraction',
};
function legacyTarget(route) {
  const m = route.match(/^\/services(?:\/([\w-]+))?\/?$/);
  if (!m) return null;
  const slug = m[1] && (LEGACY_SERVICES[m[1]] || (fs.existsSync(path.join(ROOT, 'pages', m[1] + '.html')) ? m[1] : null));
  return '/pages/' + (slug || 'services');
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
      topics: ['en', 'fr'].filter((k) => NL_TOPICS[k]).map((k) => ({ id: NL_TOPICS[k], subscription: k === (NL_TOPICS[l] ? l : 'en') ? 'opt_in' : 'opt_out' })),  // Russian has no topic of its own: English
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
  en: { dear: 'Dear', ready: 'Thank you for your interest. Your copy of our report is ready.', button: 'Download the report (PDF)',
    pre: (d) => `Your personal download link, valid for ${d} days.`,
    meta: (p) => `${p ? p + ' pages · ' : ''}PDF · English edition`,
    series: { africa: 'Africa Series', 'central-asia': 'Central Asia', other: 'Middle East & Mediterranean' }, research: 'Research', cover: 'Cover of the report',
    valid: (d) => `This personal link is valid for ${d} days. If the button does not work, copy this address into your browser:`,
    otherEd: { fr: ['This report is also available in French:', 'Download the French edition (PDF)'],
      ru: ['This report is also available in Russian:', 'Download the Russian edition (PDF)'] },
    discuss: 'If you would like to discuss the findings, simply reply to this email.',
    offices: 'Dubai · Cairo',
    why: 'You received this email because this address was entered to request a Heirstone report. To stop receiving Heirstone research, reply with "unsubscribe".',
    whyNl: (n) => `You received this email because this address was entered to request a Heirstone report. As agreed on the form, we will also send you ${n}, our research newsletter on new reports and findings. Every issue has a one-click unsubscribe link, or reply "unsubscribe" at any time.`,
    subject: 'Your Heirstone report' },
  fr: { dear: 'Bonjour', ready: 'Merci de votre intérêt. Votre exemplaire de notre rapport est prêt.', button: 'Télécharger le rapport (PDF)',
    pre: (d) => `Votre lien de téléchargement personnel, valable ${d} jours.`,
    meta: (p) => `${p ? p + ' pages · ' : ''}PDF · édition française`,
    series: { africa: 'Série Afrique', 'central-asia': 'Asie centrale', other: 'Moyen-Orient et Méditerranée' }, research: 'Recherche', cover: 'Couverture du rapport',
    valid: (d) => `Ce lien personnel est valable ${d} jours. Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :`,
    otherEd: { en: ['Ce rapport est également disponible en anglais :', 'Télécharger l’édition anglaise (PDF)'],
      ru: ['Ce rapport est également disponible en russe :', 'Télécharger l’édition russe (PDF)'] },
    discuss: 'Pour échanger sur les conclusions, il vous suffit de répondre à cet e-mail.',
    offices: 'Dubaï · Le Caire',
    why: 'Vous recevez cet e-mail car cette adresse a été saisie pour demander un rapport Heirstone. Pour ne plus recevoir nos publications, répondez « désinscription ».',
    whyNl: (n) => `Vous recevez cet e-mail car cette adresse a été saisie pour demander un rapport Heirstone. Comme convenu dans le formulaire, nous vous enverrons aussi ${n}, notre lettre de recherche sur nos nouveaux rapports et résultats. Chaque numéro comporte un lien de désinscription en un clic ; vous pouvez aussi répondre « désinscription » à tout moment.`,
    subject: 'Votre rapport Heirstone' },
  ru: { dear: 'Добрый день,', ready: 'Благодарим за интерес. Ваш экземпляр нашего отчёта готов.', button: 'Скачать отчёт (PDF)',
    pre: (d) => `Ваша персональная ссылка для скачивания действует ${d} дней.`,
    meta: (p) => `${p ? p + ' стр. · ' : ''}PDF · русская версия`,
    series: { africa: 'Серия «Африка»', 'central-asia': 'Центральная Азия', other: 'Ближний Восток и Средиземноморье' }, research: 'Исследования', cover: 'Обложка отчёта',
    valid: (d) => `Эта персональная ссылка действует ${d} дней. Если кнопка не работает, скопируйте этот адрес в браузер:`,
    otherEd: { en: ['Этот отчёт также доступен на английском языке:', 'Скачать английскую версию (PDF)'],
      fr: ['Этот отчёт также доступен на французском языке:', 'Скачать французскую версию (PDF)'] },
    discuss: 'Если вы хотите обсудить выводы отчёта, просто ответьте на это письмо.',
    offices: 'Дубай · Каир',
    why: 'Вы получили это письмо, потому что этот адрес был указан при запросе отчёта Heirstone. Чтобы больше не получать исследования Heirstone, ответьте словом «отписаться».',
    whyNl: (n) => `Вы получили это письмо, потому что этот адрес был указан при запросе отчёта Heirstone. Как указано в форме, мы также будем присылать вам ${n}, нашу рассылку о новых отчётах и выводах. В каждом выпуске есть ссылка для отписки в один клик; вы также можете в любой момент ответить «отписаться».`,
    subject: 'Ваш отчёт Heirstone' },
};

// Brand system for reader emails (Heirstone brand guidelines v1.0, same as the newsletter): Ink Navy, Paper, Slate
// and Mist; Playfair Display for display and Libre Franklin for text, with Georgia/Arial fallbacks. The layout is
// tables so Outlook renders it, and the .sx/.ss classes make Outlook fall back to Georgia/Arial rather than Times.
const BRAND = {
  ink: '#0E1B2A', paper: '#F6F4EF', card: '#FCFBF8', line: '#E4DED2', slate: '#5D6E82', tint: '#8FA0B2',
  text: '#263340', text2: '#3C4956', light: '#6E7F92',
  serif: "'Playfair Display',Georgia,'Times New Roman',serif", sans: "'Libre Franklin',Arial,Helvetica,sans-serif",
};
const mailP = (html, size, line, color, margin, serif, extra = '') =>
  `<p class="${serif ? 'sx' : 'ss'}" style="margin:${margin};font-family:${serif ? BRAND.serif : BRAND.sans};font-size:${size}px;line-height:${line}px;color:${color};${extra}">${html}</p>`;
const mailRow = (inner, pad, bg) =>
  `<tr><td class="px"${bg ? ` bgcolor="${bg}"` : ''} style="${bg ? `background-color:${bg};` : ''}padding:${pad};">${inner}</td></tr>`;

function brandedEmail({ lang, title, preheader, rows }) {
  const B = BRAND;
  return `<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting"><meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@400;600&amp;family=Playfair+Display:wght@400;500&amp;display=swap" rel="stylesheet"><!--<![endif]-->
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>.sx{font-family:Georgia,serif !important;} .ss{font-family:Arial,sans-serif !important;}</style><![endif]-->
<style>:root{color-scheme:light;supported-color-schemes:light;} body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
@media only screen and (max-width:620px){ .px{padding-left:22px !important;padding-right:22px !important;} .stack{display:block !important;width:100% !important;max-width:100% !important;} .card{padding:20px !important;} }</style>
</head>
<body style="margin:0;padding:0;background-color:${B.paper};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${B.paper};opacity:0;">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(50)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${B.paper}" style="background-color:${B.paper};"><tr><td align="center" style="padding:24px 8px 24px 8px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:${B.card};border:1px solid ${B.line};">
${rows.join('\n')}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>`;
}

// The lockup travels inside the report email as an inline (cid:) attachment, so Outlook and other
// clients that block remote images still show it. Falls back to the hosted file if it can't be read.
const LOGO_CID = 'heirstone-lockup';
let LOGO_B64 = '';
try { LOGO_B64 = fs.readFileSync(path.join(ROOT, 'Media', 'email', 'heirstone-lockup-reversed.png')).toString('base64'); }
catch (e) { console.error('Email logo missing:', e.message); }
const logoAttachment = () => (LOGO_B64
  ? [{ content: LOGO_B64, filename: 'heirstone-consulting.png', content_type: 'image/png', content_id: LOGO_CID }] : undefined);  // undefined = no attachments field at all

// Header row shared by reader-facing emails: the reversed horizontal lockup on Ink Navy.
// Alt text is styled light so the header still reads "Heirstone Consulting" if images are off.
function brandHeader(home, label, logoSrc = `${PUBLIC_ORIGIN}/Media/email/heirstone-lockup-reversed.png`) {
  const B = BRAND;
  return mailRow('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    + `<td valign="middle"><a href="${home}" style="color:#FFFFFF;text-decoration:none;"><img src="${logoSrc}" width="208" height="38" alt="Heirstone Consulting" border="0" style="display:block;width:208px;height:auto;border:0;color:#FFFFFF;font-family:${B.serif};font-size:18px;line-height:22px;letter-spacing:2px;"></a></td>`
    + `<td align="right" valign="middle" class="ss" style="font-family:${B.sans};font-size:10px;line-height:14px;letter-spacing:3px;color:${B.tint};text-transform:uppercase;">${esc(label)}</td>`
    + '</tr></table>', '26px 40px 26px 40px', B.ink);
}

function reportEmail(slug, r, name, link, l, others = []) {
  const B = BRAND;
  const t = MAIL_TEXT[l] || MAIL_TEXT.en;
  const why = NL_SEGMENT ? t.whyNl(nlName(l)) : t.why;
  const ed = edition(r, l);
  const sep = l === 'fr' ? ' : ' : ': ';  // French puts a space before the colon
  const sector = ed.sector || r.sector, short = ed.title || r.title;
  const title = `${sector}${sep}${short}`;
  const first = name.split(/\s+/)[0];
  const home = `${PUBLIC_ORIGIN}${l === 'en' ? '/' : `/${l}/`}`;
  const coverFile = `${slug}${l === 'en' ? '' : '.' + l}.jpg`;
  const cover = fs.existsSync(path.join(ROOT, 'Media', 'email', 'covers', coverFile)) ? `${PUBLIC_ORIGIN}/Media/email/covers/${coverFile}` : '';
  const kicker = `${t.series[r.series] || t.series.other} · ${sector}`;
  // One line per other edition (a report can have English, French and Russian)
  const otherEds = others.filter((o) => o.link && t.otherEd[o.lang]).map((o) => ({ link: o.link, text: t.otherEd[o.lang][0], cta: t.otherEd[o.lang][1] }));

  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${B.ink}" style="background-color:${B.ink};padding:13px 24px;">`
    + `<a href="${link}" class="ss" style="font-family:${B.sans};font-size:14px;line-height:18px;font-weight:600;color:#FFFFFF;text-decoration:none;display:inline-block;">${esc(t.button)}</a></td></tr></table>`;
  const details = mailP(esc(kicker), 11, 17, B.slate, '0 0 10px 0', false, 'letter-spacing:2px;text-transform:uppercase;font-weight:600;')
    + `<h1 class="sx" style="margin:0 0 10px 0;font-family:${B.serif};font-size:26px;line-height:32px;font-weight:400;color:${B.ink};">${esc(short)}</h1>`
    + mailP(esc(t.meta(ed.pages)), 13, 19, B.light, '0 0 20px 0')
    + button;
  // Cover beside the details in a 600px window and above them on phones; real table columns for Outlook
  const card = !cover ? details
    : '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="font-size:0;line-height:0;">'
      + '<!--[if mso]><table role="presentation" width="468" cellpadding="0" cellspacing="0" border="0"><tr><td width="132" valign="top"><![endif]-->'
      + '<div class="stack" style="display:inline-block;width:100%;max-width:132px;vertical-align:top;"><div style="padding:0 0 18px 0;">'
      + `<a href="${link}"><img src="${cover}" width="112" height="159" alt="${esc(t.cover)} ${esc(short)}" border="0" style="display:block;width:112px;height:auto;border:1px solid ${B.line};"></a></div></div>`
      + '<!--[if mso]></td><td width="336" valign="top"><![endif]-->'
      + `<div class="stack" style="display:inline-block;width:100%;max-width:336px;vertical-align:top;">${details}</div>`
      + '<!--[if mso]></td></tr></table><![endif]--></td></tr></table>';

  const rows = [
    brandHeader(home, t.research, LOGO_B64 ? `cid:${LOGO_CID}` : undefined),
    mailRow(mailP(`${esc(t.dear)} ${esc(first)},`, 16, 26, B.text, '0 0 14px 0') + mailP(esc(t.ready), 16, 26, B.text, '0'), '34px 40px 22px 40px'),
    mailRow(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="card" bgcolor="${B.paper}" style="background-color:${B.paper};border:1px solid ${B.line};padding:24px;">${card}</td></tr></table>`, '0 40px 0 40px'),
    mailRow(mailP(esc(t.valid(LINK_DAYS)), 13, 20, B.light, '0 0 4px 0')
      + mailP(`<a href="${link}" style="color:${B.slate};text-decoration:underline;word-break:break-all;">${link}</a>`, 12, 18, B.slate, '0', false, 'word-break:break-all;'), '22px 40px 0 40px'),
    ...otherEds.map((o, i) => mailRow(mailP(`${esc(o.text)} <a href="${o.link}" style="color:${B.ink};font-weight:600;text-decoration:underline;">${esc(o.cta)}</a>`, 14, 22, B.text2, '0'), `${i ? 8 : 18}px 40px 0 40px`)),
    mailRow(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${B.line};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`, '28px 40px 0 40px'),
    mailRow(mailP(esc(t.discuss), 15, 24, B.text, '0 0 18px 0')
      + mailP('Heirstone Consulting Research', 17, 22, B.ink, '0 0 2px 0', true)
      + mailP(`${esc(t.offices)} &nbsp;·&nbsp; <a href="${home}" style="color:${B.slate};text-decoration:none;">heirstoneconsulting.com</a>`, 13, 20, B.light, '0'), '24px 40px 30px 40px'),
    mailRow((NEWSLETTER.postal_address ? mailP(esc(NEWSLETTER.postal_address), 11, 17, B.light, '0 0 8px 0') : '')
      + mailP(esc(why), 11, 17, B.light, '0'), '20px 40px 24px 40px', B.paper),
  ].filter(Boolean);

  const text = `${t.dear} ${first},\n\n${t.ready}\n\n${title}\n${t.meta(ed.pages)}\n\n${t.button}${sep}${link}\n${t.valid(LINK_DAYS)}\n`
    + otherEds.map((o) => `\n${o.text} ${o.link}\n`).join('')
    + `\n${t.discuss}\n\nHeirstone Consulting Research\n${t.offices} · heirstoneconsulting.com\n`
    + (NEWSLETTER.postal_address ? `${NEWSLETTER.postal_address}\n` : '') + `\n${why}`;
  return { title, html: brandedEmail({ lang: l, title, preheader: t.pre(LINK_DAYS), rows }), text, subject: `${t.subject}${sep}${title}` };
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
    const others = Object.keys(r.editions || {}).filter((k) => k !== l).map((k) => ({ lang: k, link: linkFor(k) }));
    const mail = reportEmail(slug, r, name, link, l, others);
    try {
      const sent = await resendSend({ from: REPORT_FROM, to: [email], reply_to: CONTACT_TO[0], subject: mail.subject, html: mail.html, text: mail.text, attachments: logoAttachment() });
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
  // Same identity as the report emails: the reversed lockup (brand guidelines markup) on Ink Navy, Playfair + Franklin
  const B = BRAND;
  const mark = '<svg viewBox="0 0 100 100" width="44" height="44" aria-hidden="true"><rect x="20" y="20" width="60" height="60" fill="none" stroke="#8FA0B2" stroke-width="3"/><rect x="20" y="20" width="60" height="60" fill="none" stroke="#8FA0B2" stroke-width="3" transform="rotate(45 50 50)"/></svg>';
  const body = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link expired | Heirstone Consulting</title>'
    + '<link rel="icon" href="/favicon.svg"><link href="https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@300;400;600&family=Playfair+Display:wght@400;500&display=swap" rel="stylesheet"></head>'
    + `<body style="margin:0;font-family:${B.sans};background:${B.paper};color:${B.text}"><div style="max-width:560px;margin:10vh auto;padding:0 16px">`
    + `<div style="background:${B.ink};padding:24px 32px"><a href="/" style="display:inline-flex;align-items:center;gap:16px;text-decoration:none">${mark}`
    + `<span style="line-height:1"><span style="display:block;font-family:${B.serif};font-size:21px;letter-spacing:.22em;color:${B.paper};font-weight:500">HEIRSTONE</span>`
    + `<span style="display:block;font-size:9px;letter-spacing:.42em;color:${B.tint};margin-top:6px">CONSULTING</span></span></a></div>`
    + `<div style="background:${B.card};border:1px solid ${B.line};border-top:0;padding:36px 32px 40px">`
    + `<p style="margin:0 0 12px;font-size:11px;letter-spacing:.28em;font-weight:600;color:${B.slate}">HEIRSTONE CONSULTING RESEARCH</p>`
    + `<h1 style="margin:0 0 16px;font-family:${B.serif};font-size:30px;line-height:1.2;font-weight:400;color:${B.ink}">This download link has expired</h1>`
    + `<p style="margin:0 0 28px;font-size:16px;line-height:1.7;font-weight:300">Personal report links are valid for ${LINK_DAYS} days. Request a new one and we will email it to you straight away.</p>`
    + `<a href="/pages/reports" style="display:inline-block;background:${B.ink};color:#fff;text-decoration:none;padding:13px 24px;font-size:14px;font-weight:600">Go to Reports</a></div></div></body></html>`;
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
    // Plain-ASCII fallback for old clients; a name in another script (Russian) falls back to the file name
    const ascii = /[^\x00-\x7f]/.test(name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'"))
      ? `Heirstone Consulting Research - ${path.basename(ed.file)}`
      : name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'");
    res.writeHead(200, {
      'Content-Type': 'application/pdf', 'Content-Length': st.size,
      'Content-Disposition': `attachment; filename="${ascii.replace(/[^\x20-\x7e]/g, '').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
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
  // HSTS on the production domain (https only from now on), plus two standard hardening headers
  const host = req.headers.host || '';
  if (ANALYTICS_HOST.test(host.replace(/:\d+$/, ''))) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Redirect non-www to www
  if (host && !host.startsWith('www.') && !host.startsWith('localhost') && !host.startsWith('127.')) {
    return send(res, 301, { 'Location': 'https://www.' + host + req.url });
  }

  const route = req.url.split('?')[0];
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  const legacy = legacyTarget(route);
  if (legacy) return send(res, 301, { 'Location': legacy, 'Cache-Control': 'public, max-age=86400' });
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

  // CSS and JS: minified, precompressed, cached for a year when the link carries the current ?v=
  const a = (req.method === 'GET' || req.method === 'HEAD') && asset(urlPath);
  if (a) {
    const fresh = new URLSearchParams(query).get('v') === a.v;
    const tag = `"${a.v}${a.min ? '-m' : ''}"`;
    const headers = { 'Content-Type': mimeTypes[path.extname(urlPath)], 'Cache-Control': fresh ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      'ETag': tag, 'Vary': 'Accept-Encoding' };
    if (req.headers['if-none-match'] === tag) return send(res, 304, headers);
    const enc = acceptedEncoding(req);
    const body = enc === 'br' ? a.br : enc === 'gzip' ? a.gz : a.body;
    if (enc) headers['Content-Encoding'] = enc;
    headers['Content-Length'] = body.length;
    return send(res, 200, headers, body);
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
            sendText(req, res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, err3 ? '<h1>404 - Page Not Found</h1>' : renderPage(req, data3));
          });
        } else {
          sendText(req, res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, renderPage(req, data2));
        }
      });
      return;
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Vary'] = 'Accept-Language, Cookie';
    if (STATIC_CACHE[ext]) headers['Cache-Control'] = `public, max-age=${STATIC_CACHE[ext]}`;
    if (ext === '.html') return sendText(req, res, 200, headers, renderPage(req, data));
    if (COMPRESSIBLE.has(ext)) return sendText(req, res, 200, headers, data);
    headers['Content-Length'] = data.length;
    send(res, 200, headers, data);
  });
});

server.listen(PORT, () => {
  console.log(`Heirstone server running on port ${PORT}`);
});

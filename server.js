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
const LANGS = ['zh', 'ja', 'es', 'fr', 'it', 'pt', 'de', 'fi', 'da', 'ro', 'ru', 'ky', 'kk', 'tr'];
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

const server = http.createServer((req, res) => {
  // Redirect non-www to www
  const host = req.headers.host || '';
  if (host && !host.startsWith('www.') && !host.startsWith('localhost') && !host.startsWith('127.')) {
    return send(res, 301, { 'Location': 'https://www.' + host + req.url });
  }

  if (req.url.split('?')[0] === '/api/contact') return handleContact(req, res);

  let urlPath = req.url.split('?')[0]; // strip query strings
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  try { urlPath = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, {}, 'Bad request'); }

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

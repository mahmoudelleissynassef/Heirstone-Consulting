const http = require('http');
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

const server = http.createServer((req, res) => {
  // Redirect non-www to www
  const host = req.headers.host || '';
  if (host && !host.startsWith('www.') && !host.startsWith('localhost') && !host.startsWith('127.')) {
    return send(res, 301, { 'Location': 'https://www.' + host + req.url });
  }

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

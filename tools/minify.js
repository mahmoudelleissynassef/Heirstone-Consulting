// Minified copies of the site's CSS and JavaScript, served by server.js.
//
//   npm i --no-save esbuild && node tools/minify.js        (run after editing anything in css/ or js/)
//
// Writes min/css/*.css and min/js/*.js. Each copy starts with the hash of the source it came from;
// server.js serves a copy only while that hash matches the current source, so a forgotten re-run
// can never serve stale code: the server falls back to the readable source until the copy is rebuilt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let esbuild;
try { esbuild = require(process.env.ESBUILD_PATH || 'esbuild'); } catch (e) {
  console.error('esbuild is not installed. Run: npm i --no-save esbuild'); process.exit(1);
}
const ROOT = path.join(__dirname, '..');
// Line endings are ignored, so a Windows checkout (CRLF) and the Linux server (LF) agree on the hash
const hash = (s) => crypto.createHash('sha1').update(s.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);

for (const dir of ['css', 'js']) {
  fs.mkdirSync(path.join(ROOT, 'min', dir), { recursive: true });
  for (const name of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.' + dir)).sort()) {
    const src = fs.readFileSync(path.join(ROOT, dir, name), 'utf8');
    const out = esbuild.transformSync(src, { loader: dir, minify: true, legalComments: 'none', charset: 'utf8' }).code;
    fs.writeFileSync(path.join(ROOT, 'min', dir, name), `/*! src:${hash(src)} */\n${out}`);
    console.log(`${dir}/${name}: ${src.length} -> ${out.length} bytes`);
  }
}

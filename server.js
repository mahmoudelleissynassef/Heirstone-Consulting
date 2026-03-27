const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0]; // strip query strings

  // Default to index.html
  if (urlPath === '/') urlPath = '/index.html';

  let filePath = path.join(__dirname, urlPath);

  // If no extension, try adding .html
  if (!path.extname(filePath)) {
    filePath += '.html';
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Try 404 page or fallback
      fs.readFile(path.join(__dirname, '404.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<h1>404 - Page Not Found</h1>');
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end(data2);
        }
      });
      return;
    }

    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Heirstone server running on port ${PORT}`);
});

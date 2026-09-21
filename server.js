'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const proxyHandler = require('./api/proxy');
const troopsHandler = require('./api/troops');
const verifySuperTicketHandler = require('./api/verify-super-ticket');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function collectBody(req, done) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    req.body = body;
    done();
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  req.query = parsedUrl.query;

  if (pathname === '/api/proxy') {
    return collectBody(req, () => proxyHandler(req, res));
  }
  if (pathname === '/api/troops') return troopsHandler(req, res);
  if (pathname === '/api/verify-super-ticket') {
    return collectBody(req, () => verifySuperTicketHandler(req, res));
  }

  const filePath = path.resolve(__dirname, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (!filePath.startsWith(`${__dirname}${path.sep}`) && filePath !== path.join(__dirname, 'index.html')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Development preview server running at http://${HOST}:${PORT}`);
});

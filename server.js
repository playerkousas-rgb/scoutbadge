const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const proxyHandler = require('./api/proxy');
const troopsHandler = require('./api/troops');
const healthHandler = require('./api/health');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Route: /api/proxy
  if (pathname === '/api/proxy') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      req.body = body;
      req.query = parsedUrl.query;
      proxyHandler(req, res);
    });
    return;
  }

  // Route: /api/troops
  if (pathname === '/api/troops') {
    req.query = parsedUrl.query;
    troopsHandler(req, res);
    return;
  }

  // Route: /api/health - 新增用於排查「找不到82的SHEET」
  if (pathname === '/api/health') {
    req.query = parsedUrl.query;
    healthHandler(req, res);
    return;
  }

  // Static files
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

  // Security check to prevent path traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found - 若你看到找不到82的SHEET，請檢查 /api/troops 與 /api/health?troopId=0082');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Development preview server running at http://${HOST}:${PORT}`);
  console.log(`Health check: http://${HOST}:${PORT}/api/health?troopId=0082`);
});

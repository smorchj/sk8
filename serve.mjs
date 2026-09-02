// Minimal static file server for the anim-demo folder. No build step, no deps.
// Usage: node serve.mjs [port]   (defaults to 5180)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 5101;   // 5101: creategamecharacters.ai project origin lock
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    // Dev-only drop box: the site's Pose Studio (driven by an agent in the
    // owner's browser) POSTs exported takes / measurements here, into the
    // gitignored _scratch/ folder. Loopback only, plain-text bodies (no preflight).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' });
      res.end(); return;
    }
    if (req.method === 'POST' && urlPath.startsWith('/_scratch/')) {
      const target = path.normalize(path.join(ROOT, urlPath));
      if (!target.startsWith(path.join(ROOT, '_scratch')) || /[\\/]\.\./.test(urlPath)) { res.writeHead(403); res.end('Forbidden'); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.concat(chunks));
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
        res.end('ok ' + Buffer.concat(chunks).length);
      });
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
        // loopback is a trustworthy origin: the site's Pose Studio (https) may
        // fetch videos/assets from here for agent-driven mocap
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    res.writeHead(500); res.end('Server error: ' + e.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`anim-demo serving http://${HOST}:${PORT}/  (root: ${ROOT})`);
});

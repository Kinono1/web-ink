import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
createServer(async (req, res) => {
  const name = req.url?.split('?')[0] === '/diagram.svg' ? 'diagram.svg' : 'article.html';
  try {
    res.setHeader('Content-Type', name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8');
    res.end(await readFile(root + name));
  } catch { res.writeHead(500); res.end('Fixture unavailable'); }
}).listen(4173, '127.0.0.1');

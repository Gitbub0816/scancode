import http from 'node:http';
import worker from '../site-dist/worker/index.js';

const port = Number(process.env.PORT || 4173);
http.createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const url = `http://${incoming.headers.host || `127.0.0.1:${port}`}${incoming.url || '/'}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers,
      body: ['GET', 'HEAD'].includes(incoming.method || '') ? undefined : Buffer.concat(chunks)
    });
    const response = await worker.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { 'content-type': 'text/plain' });
    outgoing.end(error instanceof Error ? error.message : 'Server error');
  }
}).listen(port, '127.0.0.1', () => console.log(`AsterHalo preview: http://127.0.0.1:${port}/`));

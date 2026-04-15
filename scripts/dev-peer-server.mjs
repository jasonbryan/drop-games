import { PeerServer } from 'peer';

const port = Number(process.env.PEER_PORT ?? 9000);
const path = '/drop-games';

PeerServer({
  port,
  path,
  proxied: true,
});

console.log(`PeerJS dev server listening on http://localhost:${port}${path}`);

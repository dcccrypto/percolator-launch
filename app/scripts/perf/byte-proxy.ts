/**
 * Tiny TCP proxy that counts the bytes a Postgres server sends to its client (the egress Supabase
 * bills). Perf harness only (app/scripts/perf): point a postgres:// URL at the proxy port and read
 * `serverToClient` around the code under test.
 *
 *   const p = await startByteProxy({ upstreamHost: "127.0.0.1", upstreamPort: 54329 });
 *   ... connect to 127.0.0.1:p.port ...
 *   p.reset(); await work(); p.serverToClient   // bytes
 */
import { createConnection, createServer, type Server, type Socket } from "node:net";

export interface ByteProxy {
  port: number;
  /** Bytes upstream -> client since the last reset. */
  readonly serverToClient: number;
  /** Bytes client -> upstream since the last reset. */
  readonly clientToServer: number;
  reset(): void;
  close(): Promise<void>;
}

export async function startByteProxy(opts: { upstreamHost: string; upstreamPort: number; listenPort?: number }): Promise<ByteProxy> {
  let down = 0;
  let up = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = createConnection({ host: opts.upstreamHost, port: opts.upstreamPort });
    sockets.add(client);
    sockets.add(upstream);
    upstream.on("data", (chunk: Buffer) => { down += chunk.length; });
    client.on("data", (chunk: Buffer) => { up += chunk.length; });
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", end);
    upstream.on("error", end);
  });
  await new Promise<void>((resolve) => server.listen(opts.listenPort ?? 0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    get serverToClient() { return down; },
    get clientToServer() { return up; },
    reset() { down = 0; up = 0; },
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

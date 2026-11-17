import { request, type Server } from 'http';
import type { AddressInfo } from 'net';
import { closeGracefully, createHttpApp, extractApiKey, type HttpAppOptions } from '../src/http';

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.1' } },
  id: 1,
});
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function listen(options: HttpAppOptions): Promise<{ server: Server; baseUrl: string; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpApp(options).listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, port });
    });
  });
}

/** fetch() refuses to override Host, so spoofed-Host requests go through node:http. */
function statusWithHost(port: number, host: string, path = '/healthz'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('extractApiKey', () => {
  it('prefers the x-api-key header', () => {
    expect(extractApiKey({ 'x-api-key': 'vltx_a', authorization: 'Bearer vltx_b' })).toBe('vltx_a');
  });

  it('accepts Authorization: Bearer', () => {
    expect(extractApiKey({ authorization: 'Bearer vltx_b' })).toBe('vltx_b');
  });

  it('accepts Authorization: ApiKey', () => {
    expect(extractApiKey({ authorization: 'ApiKey vltx_c' })).toBe('vltx_c');
  });

  it('returns undefined when no credential is present', () => {
    expect(extractApiKey({})).toBeUndefined();
    expect(extractApiKey({ authorization: 'Basic dXNlcjpwYXNz' })).toBeUndefined();
  });
});

describe('HTTP transport endpoint', () => {
  let server: Server;
  let baseUrl: string;
  let port: number;

  beforeAll(async () => {
    ({ server, baseUrl, port } = await listen({ apiUrl: 'http://localhost:5000' }));
  });

  afterAll(() => close(server));

  it('serves a health check', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'veltrix-mcp' });
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('rejects /mcp requests without an API key (401)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: INITIALIZE });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Missing Veltrix API key');
  });

  it('rejects a credential that is not a Veltrix API key before building a session (401)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.not-a-veltrix-key' },
      body: INITIALIZE,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Invalid Veltrix API key format');
  });

  it('initializes an MCP session for a well-formed key', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer vltx_wellformed' },
      body: INITIALIZE,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"name":"veltrix"');
  });

  it('rejects GET /mcp in stateless mode (405)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('does not validate the Host header when callers bring their own key (reverse-proxy deployments)', async () => {
    expect(await statusWithHost(port, 'app.example.com')).toBe(200);
  });
});

describe('Host header validation', () => {
  it('defaults to localhost-only when the process holds a fallback key', async () => {
    const { server, port } = await listen({ apiUrl: 'http://localhost:5000', fallbackApiKey: 'vltx_fallback' });
    try {
      expect(await statusWithHost(port, 'attacker.example')).toBe(403);
      expect(await statusWithHost(port, `127.0.0.1:${port}`)).toBe(200);
      expect(await statusWithHost(port, 'localhost')).toBe(200);
    } finally {
      await close(server);
    }
  });

  it('enforces an explicit allowlist', async () => {
    const { server, port } = await listen({ apiUrl: 'http://localhost:5000', allowedHosts: ['mcp.example.com'] });
    try {
      expect(await statusWithHost(port, 'mcp.example.com')).toBe(200);
      expect(await statusWithHost(port, 'mcp.example.com:443')).toBe(200);
      expect(await statusWithHost(port, 'other.example.com')).toBe(403);
      expect(await statusWithHost(port, `127.0.0.1:${port}`)).toBe(403);
    } finally {
      await close(server);
    }
  });
});

describe('closeGracefully', () => {
  it('stops accepting connections and resolves once the server has closed', async () => {
    const { server, baseUrl } = await listen({ apiUrl: 'http://localhost:5000' });
    await fetch(`${baseUrl}/healthz`);

    await closeGracefully(server, 1_000);

    expect(server.listening).toBe(false);
    await expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow();
  });
});

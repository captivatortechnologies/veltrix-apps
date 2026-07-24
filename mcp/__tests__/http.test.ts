import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createHttpApp, extractApiKey } from '../src/http';

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

  beforeAll((done) => {
    const app = createHttpApp({ apiUrl: 'http://localhost:5000' });
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  it('serves a health check', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'veltrix-mcp' });
  });

  it('rejects /mcp requests without an API key (401)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: {}, id: 1 }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Missing Veltrix API key');
  });

  it('rejects GET /mcp in stateless mode (405)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
  });
});

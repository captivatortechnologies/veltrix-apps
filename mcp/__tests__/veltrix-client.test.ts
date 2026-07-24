import { VeltrixClient, VeltrixApiError, MCP_ENTITLEMENT_PATH } from '../src/veltrix-client';

describe('VeltrixClient', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  function mockResponse(status: number, body: unknown): void {
    fetchMock.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    });
  }

  it('sends the API key header and parses JSON', async () => {
    mockResponse(200, { valid: true });
    const client = new VeltrixClient('http://localhost:5000', 'vltx_test');

    const result = await client.get<{ valid: boolean }>('/api/auth/api-key/check');

    expect(result.valid).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:5000/api/auth/api-key/check');
    expect(init.headers['x-api-key']).toBe('vltx_test');
    expect(init.method).toBe('GET');
  });

  it('strips trailing slashes from the base URL', async () => {
    mockResponse(200, {});
    const client = new VeltrixClient('http://localhost:5000///', 'vltx_test');
    await client.get('/api/apps');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:5000/api/apps');
  });

  it('serializes defined query params and skips undefined ones', async () => {
    mockResponse(200, { data: [] });
    const client = new VeltrixClient('http://localhost:5000', 'vltx_test');

    await client.get('/api/configuration-canvas', { status: 'DRAFT', page: 2, toolType: undefined });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get('status')).toBe('DRAFT');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.has('toolType')).toBe(false);
  });

  it('POSTs a JSON body with content-type', async () => {
    mockResponse(201, { deploymentId: 'd-1' });
    const client = new VeltrixClient('http://localhost:5000', 'vltx_test');

    await client.post('/api/pipeline/canvas/c-1/deploy', { environmentId: 'e-1' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ environmentId: 'e-1' });
  });

  it.each([
    [401, 'invalid, revoked, or expired'],
    [402, 'Payment required'],
    [403, 'bound role lacks the required permission'],
    [429, 'Rate limit or tier quota'],
  ])('maps HTTP %s to an actionable VeltrixApiError', async (status, hint) => {
    mockResponse(status as number, { error: 'server detail' });
    const client = new VeltrixClient('http://localhost:5000', 'vltx_test');

    await expect(client.get('/api/pipeline/summary')).rejects.toThrow(VeltrixApiError);
    try {
      await client.get('/api/pipeline/summary');
    } catch (error) {
      const apiError = error as VeltrixApiError;
      expect(apiError.status).toBe(status);
      expect(apiError.detail).toBe('server detail');
      expect(apiError.message).toContain('server detail');
      expect(apiError.message).toContain(hint as string);
    }
  });

  it('tolerates non-JSON error bodies', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => 'Bad Gateway' });
    const client = new VeltrixClient('http://localhost:5000', 'vltx_test');

    await expect(client.get('/api/apps')).rejects.toMatchObject({ status: 502, detail: 'Bad Gateway' });
  });

  it('sends an abort signal so requests cannot hang past the timeout', async () => {
    mockResponse(200, {});
    const client = new VeltrixClient('http://localhost:5000', 'vltx_test', { timeoutMs: 5000 });

    await client.get('/api/apps');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a timed-out request to an actionable VeltrixApiError', async () => {
    const timeoutError = new Error('operation timed out');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeoutError);
    const client = new VeltrixClient('http://localhost:5000', 'vltx_test', { timeoutMs: 1234 });

    await expect(client.get('/api/pipeline/summary')).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('timed out after 1234ms'),
    });
  });

  it('maps a connection failure to an actionable VeltrixApiError', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const client = new VeltrixClient('http://localhost:5000', 'vltx_test');

    await expect(client.get('/api/apps')).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('Could not reach the Veltrix API at http://localhost:5000'),
    });
  });

  describe('tier entitlement gate (enforceEntitlement)', () => {
    function mockOnce(status: number, body: unknown): void {
      fetchMock.mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
      });
    }

    it('checks entitlement before the first request and caches the result', async () => {
      const client = new VeltrixClient('http://localhost:5000', 'vltx_test', { enforceEntitlement: true });
      mockOnce(200, { enabled: true, tier: 'starter' });
      mockOnce(200, { data: [] });
      mockOnce(200, { data: [] });

      await client.get('/api/apps');
      await client.get('/api/environments');

      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls[0]).toBe(`http://localhost:5000${MCP_ENTITLEMENT_PATH}`);
      expect(urls.filter((url) => url.includes(MCP_ENTITLEMENT_PATH))).toHaveLength(1);
    });

    it('refuses tool calls with an upgrade message when the tier lacks MCP access', async () => {
      const client = new VeltrixClient('http://localhost:5000', 'vltx_test', { enforceEntitlement: true });
      mockOnce(200, { enabled: false, tier: 'free' });

      await expect(client.get('/api/apps')).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining(`not included in this tenant's current plan (tier "free")`),
      });
    });

    it('treats a 404 entitlement endpoint as open (older platform)', async () => {
      const client = new VeltrixClient('http://localhost:5000', 'vltx_test', { enforceEntitlement: true });
      mockOnce(404, { error: 'Not found' });
      mockOnce(200, { data: [] });

      await expect(client.get('/api/apps')).resolves.toEqual({ data: [] });
    });

    it('is off by default (no extra request)', async () => {
      mockResponse(200, {});
      const client = new VeltrixClient('http://localhost:5000', 'vltx_test');

      await client.get('/api/apps');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).not.toContain(MCP_ENTITLEMENT_PATH);
    });
  });
});

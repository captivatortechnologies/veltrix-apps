import { DEFAULT_API_URL, DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, isVeltrixApiKey, loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('defaults to stdio against the local API', () => {
    expect(loadConfig([], {})).toEqual({
      command: 'serve',
      http: false,
      apiUrl: DEFAULT_API_URL,
      apiKey: undefined,
      httpPort: DEFAULT_HTTP_PORT,
      httpHost: DEFAULT_HTTP_HOST,
      allowedHosts: undefined,
      apiTimeoutMs: undefined,
    });
  });

  it('reads the environment and strips trailing slashes from the API URL', () => {
    const config = loadConfig(['--http'], {
      VELTRIX_API_URL: 'https://app.example.com//',
      VELTRIX_API_KEY: 'vltx_abc',
      VELTRIX_MCP_PORT: '6100',
      VELTRIX_MCP_HOST: '0.0.0.0',
      VELTRIX_MCP_ALLOWED_HOSTS: 'app.example.com, mcp.example.com ,',
      VELTRIX_API_TIMEOUT_MS: '5000',
    });

    expect(config).toMatchObject({
      http: true,
      apiUrl: 'https://app.example.com',
      apiKey: 'vltx_abc',
      httpPort: 6100,
      httpHost: '0.0.0.0',
      allowedHosts: ['app.example.com', 'mcp.example.com'],
      apiTimeoutMs: 5000,
    });
  });

  it('lets flags win over the environment', () => {
    const config = loadConfig(['--http', '--port', '7000', '--host', '::1'], {
      VELTRIX_MCP_PORT: '6100',
      VELTRIX_MCP_HOST: '0.0.0.0',
    });
    expect(config.httpPort).toBe(7000);
    expect(config.httpHost).toBe('::1');
  });

  it.each([
    [['--port', 'abc'], {}],
    [['--port', '70000'], {}],
    [[], { VELTRIX_MCP_PORT: '-1' }],
    [[], { VELTRIX_API_TIMEOUT_MS: '0' }],
  ])('rejects invalid numeric settings %j %j', (argv, env) => {
    expect(() => loadConfig(argv as string[], env as NodeJS.ProcessEnv)).toThrow(/Invalid/);
  });

  it.each([
    [['--help'], 'help'],
    [['-h'], 'help'],
    [['--version'], 'version'],
    [['-v'], 'version'],
    [['--http'], 'serve'],
  ])('resolves %j to the %s command', (argv, command) => {
    expect(loadConfig(argv as string[], {}).command).toBe(command);
  });

  it('treats an empty VELTRIX_API_KEY as unset', () => {
    expect(loadConfig([], { VELTRIX_API_KEY: '' }).apiKey).toBeUndefined();
  });
});

describe('isVeltrixApiKey', () => {
  it('accepts vltx_ keys only', () => {
    expect(isVeltrixApiKey('vltx_abc123')).toBe(true);
    expect(isVeltrixApiKey('vltx_')).toBe(false);
    expect(isVeltrixApiKey('sk-abc')).toBe(false);
    expect(isVeltrixApiKey('')).toBe(false);
    expect(isVeltrixApiKey(undefined)).toBe(false);
  });
});

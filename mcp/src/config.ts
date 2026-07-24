export const DEFAULT_API_URL = 'http://localhost:5000';
export const DEFAULT_HTTP_PORT = 5100;

export interface VeltrixMcpConfig {
  /** Base URL of the Veltrix API (no trailing slash). */
  apiUrl: string;
  /** Veltrix API key (vltx_...). Required for stdio; optional fallback for HTTP mode. */
  apiKey?: string;
  /** Port for --http mode. */
  httpPort: number;
  /** Bind host for --http mode. Defaults to loopback — set --host 0.0.0.0 (or VELTRIX_MCP_HOST) deliberately for remote exposure. */
  httpHost: string;
  /** Per-request Veltrix API timeout in ms. */
  apiTimeoutMs?: number;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): VeltrixMcpConfig & { http: boolean } {
  const http = argv.includes('--http');

  const portFlagIdx = argv.indexOf('--port');
  const portFromFlag = portFlagIdx >= 0 ? Number(argv[portFlagIdx + 1]) : undefined;
  const portFromEnv = process.env.VELTRIX_MCP_PORT ? Number(process.env.VELTRIX_MCP_PORT) : undefined;
  const httpPort = portFromFlag ?? portFromEnv ?? DEFAULT_HTTP_PORT;
  if (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535) {
    throw new Error(`Invalid MCP HTTP port: ${portFromFlag ?? portFromEnv}`);
  }

  const hostFlagIdx = argv.indexOf('--host');
  const httpHost = (hostFlagIdx >= 0 ? argv[hostFlagIdx + 1] : undefined) ?? process.env.VELTRIX_MCP_HOST ?? '127.0.0.1';

  const apiTimeoutMs = process.env.VELTRIX_API_TIMEOUT_MS ? Number(process.env.VELTRIX_API_TIMEOUT_MS) : undefined;
  if (apiTimeoutMs !== undefined && (!Number.isInteger(apiTimeoutMs) || apiTimeoutMs <= 0)) {
    throw new Error(`Invalid VELTRIX_API_TIMEOUT_MS: ${process.env.VELTRIX_API_TIMEOUT_MS}`);
  }

  return {
    http,
    apiUrl: (process.env.VELTRIX_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ''),
    apiKey: process.env.VELTRIX_API_KEY,
    httpPort,
    httpHost,
    apiTimeoutMs,
  };
}

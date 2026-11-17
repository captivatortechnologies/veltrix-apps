export const DEFAULT_API_URL = 'http://localhost:5000';
export const DEFAULT_HTTP_PORT = 5100;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const API_KEY_PREFIX = 'vltx_';

export const HELP_TEXT = `Veltrix MCP server — propose-only AI-assistant access to a Veltrix tenant.

Usage:
  veltrix-mcp                 stdio transport (Claude Desktop, Claude Code, Cursor, ...)
  veltrix-mcp --http          Streamable HTTP transport on POST /mcp

Options:
  --http                      Serve Streamable HTTP instead of stdio
  --port <n>                  HTTP port (default ${DEFAULT_HTTP_PORT})
  --host <addr>               HTTP bind address (default ${DEFAULT_HTTP_HOST})
  -v, --version               Print the version
  -h, --help                  Print this help

Environment:
  VELTRIX_API_URL             Veltrix API base URL (default ${DEFAULT_API_URL})
  VELTRIX_API_KEY             Role-bound API key (${API_KEY_PREFIX}...). Required for stdio;
                              optional server-side fallback for --http
  VELTRIX_MCP_PORT            Same as --port
  VELTRIX_MCP_HOST            Same as --host
  VELTRIX_MCP_ALLOWED_HOSTS   Comma-separated Host header allowlist for --http
  VELTRIX_API_TIMEOUT_MS      Per-request API timeout (default 30000)
  VELTRIX_MCP_MAX_RESULT_CHARS  Cap on one tool result (default 60000)
`;

export type CliCommand = 'serve' | 'help' | 'version';

export interface VeltrixMcpConfig {
  command: CliCommand;
  http: boolean;
  /** Base URL of the Veltrix API (no trailing slash). */
  apiUrl: string;
  /** Veltrix API key. Required for stdio; optional fallback for HTTP mode. */
  apiKey?: string;
  httpPort: number;
  /** Loopback by default — set --host 0.0.0.0 (or VELTRIX_MCP_HOST) deliberately for remote exposure. */
  httpHost: string;
  /** Host header allowlist for HTTP mode (hostnames without ports). */
  allowedHosts?: string[];
  apiTimeoutMs?: number;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${label}: ${raw}`);
  return value;
}

function parseList(raw: string | undefined): string[] | undefined {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function isVeltrixApiKey(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): VeltrixMcpConfig {
  const command: CliCommand =
    argv.includes('--help') || argv.includes('-h')
      ? 'help'
      : argv.includes('--version') || argv.includes('-v')
        ? 'version'
        : 'serve';

  const httpPort =
    parsePositiveInt(flagValue(argv, '--port'), 'MCP HTTP port') ??
    parsePositiveInt(env.VELTRIX_MCP_PORT, 'MCP HTTP port') ??
    DEFAULT_HTTP_PORT;
  if (httpPort > 65535) throw new Error(`Invalid MCP HTTP port: ${httpPort}`);

  return {
    command,
    http: argv.includes('--http'),
    apiUrl: (env.VELTRIX_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, ''),
    apiKey: env.VELTRIX_API_KEY || undefined,
    httpPort,
    httpHost: flagValue(argv, '--host') ?? env.VELTRIX_MCP_HOST ?? DEFAULT_HTTP_HOST,
    allowedHosts: parseList(env.VELTRIX_MCP_ALLOWED_HOSTS),
    apiTimeoutMs: parsePositiveInt(env.VELTRIX_API_TIMEOUT_MS, 'VELTRIX_API_TIMEOUT_MS'),
  };
}

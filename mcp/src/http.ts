import express, { type Express, type Request, type Response } from 'express';
import type { IncomingHttpHeaders } from 'http';
import type { Server } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './server';

/**
 * Extracts the caller's Veltrix API key from request headers. Accepts:
 *   x-api-key: vltx_...
 *   Authorization: Bearer vltx_...
 *   Authorization: ApiKey vltx_...
 */
export function extractApiKey(headers: IncomingHttpHeaders): string | undefined {
  const headerKey = headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.length > 0) return headerKey;

  const auth = headers.authorization;
  if (typeof auth === 'string') {
    if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
    if (auth.startsWith('ApiKey ')) return auth.slice('ApiKey '.length);
  }
  return undefined;
}

export interface HttpAppOptions {
  apiUrl: string;
  /** Optional server-side fallback key when the client sends none. */
  fallbackApiKey?: string;
  /** Per-request Veltrix API timeout in ms. */
  apiTimeoutMs?: number;
}

/**
 * Stateless Streamable HTTP host: each POST /mcp builds a fresh server+transport
 * bound to the caller's API key, so one process safely serves many tenants and
 * scales horizontally with no session affinity.
 */
export function createHttpApp(options: HttpAppOptions): Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'veltrix-mcp' });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req.headers) ?? options.fallbackApiKey;
    if (!apiKey) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Missing Veltrix API key. Send "Authorization: Bearer <vltx_...>" or an "x-api-key" header.',
        },
        id: null,
      });
      return;
    }

    const server = buildMcpServer({ apiUrl: options.apiUrl, apiKey, timeoutMs: options.apiTimeoutMs });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server runs in stateless mode; use POST /mcp.' },
      id: null,
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

export function startHttpServer(options: HttpAppOptions & { port: number; host?: string }): Server {
  const app = createHttpApp(options);
  // Loopback by default: this endpoint forwards tenant API keys, so exposing it
  // beyond localhost must be a deliberate choice (--host 0.0.0.0 / VELTRIX_MCP_HOST).
  const host = options.host ?? '127.0.0.1';
  return app.listen(options.port, host, () => {
    // eslint-disable-next-line no-console
    console.error(`Veltrix MCP server (Streamable HTTP) listening on ${host}:${options.port} -> ${options.apiUrl}`);
  });
}

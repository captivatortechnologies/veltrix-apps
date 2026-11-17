import express, { type Express, type Request, type Response } from 'express';
import type { IncomingHttpHeaders, Server } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { DEFAULT_HTTP_HOST, isVeltrixApiKey } from './config';
import { buildMcpServer } from './server';

export const SHUTDOWN_GRACE_MS = 10_000;

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
  /** Host header allowlist (hostnames without ports). */
  allowedHosts?: string[];
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Stateless Streamable HTTP host: each POST /mcp builds a fresh server+transport
 * bound to the caller's API key, so one process safely serves many tenants and
 * scales horizontally with no session affinity.
 */
export function createHttpApp(options: HttpAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  // DNS-rebinding defence. A caller-supplied key is not ambient authority, so
  // host validation is opt-in there (it sits behind a reverse proxy that sets
  // the public Host). With a fallback key the process itself holds a
  // credential any local web page could borrow, so localhost-only is the default.
  if (options.allowedHosts?.length) {
    app.use(hostHeaderValidation(options.allowedHosts));
  } else if (options.fallbackApiKey) {
    app.use(localhostHostValidation());
  }

  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'veltrix-mcp' });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const apiKey = extractApiKey(req.headers) ?? options.fallbackApiKey;
    if (!apiKey) {
      jsonRpcError(
        res,
        401,
        -32001,
        'Missing Veltrix API key. Send "Authorization: Bearer <vltx_...>" or an "x-api-key" header.',
      );
      return;
    }
    if (!isVeltrixApiKey(apiKey)) {
      jsonRpcError(res, 401, -32001, 'Invalid Veltrix API key format. Keys start with "vltx_".');
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
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed: this server runs in stateless mode; use POST /mcp.');
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}

/** Stops accepting connections, lets in-flight calls finish, then force-closes. */
export function closeGracefully(server: Server, graceMs: number = SHUTDOWN_GRACE_MS): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => server.closeAllConnections(), graceMs);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}

export function startHttpServer(options: HttpAppOptions & { port: number; host?: string }): Server {
  const app = createHttpApp(options);
  const host = options.host ?? DEFAULT_HTTP_HOST;
  const server = app.listen(options.port, host, () => {
    console.error(`Veltrix MCP server (Streamable HTTP) listening on ${host}:${options.port} -> ${options.apiUrl}`);
  });

  const shutdown = (signal: NodeJS.Signals) => {
    console.error(`Veltrix MCP server received ${signal}; draining connections...`);
    void closeGracefully(server).then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return server;
}

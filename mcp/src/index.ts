#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config';
import { buildMcpServer } from './server';
import { startHttpServer } from './http';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.http) {
    startHttpServer({
      apiUrl: config.apiUrl,
      fallbackApiKey: config.apiKey,
      port: config.httpPort,
      host: config.httpHost,
      apiTimeoutMs: config.apiTimeoutMs,
    });
    return;
  }

  // stdio mode: the key comes from the environment (set by the MCP client config).
  if (!config.apiKey) {
    console.error(
      'VELTRIX_API_KEY is required in stdio mode. Create a role-bound API key in the Veltrix portal ' +
        '(Settings -> API Keys) and set it in your MCP client configuration.',
    );
    process.exit(1);
  }

  const server = buildMcpServer({ apiUrl: config.apiUrl, apiKey: config.apiKey, timeoutMs: config.apiTimeoutMs });
  await server.connect(new StdioServerTransport());
  // stdout belongs to the protocol in stdio mode — log to stderr only.
  console.error(`Veltrix MCP server running on stdio -> ${config.apiUrl}`);
}

main().catch((error) => {
  console.error('Veltrix MCP server failed to start:', error);
  process.exit(1);
});

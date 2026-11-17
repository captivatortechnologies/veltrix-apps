#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HELP_TEXT, isVeltrixApiKey, loadConfig } from './config';
import { SERVER_VERSION, buildMcpServer } from './server';
import { startHttpServer } from './http';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.command === 'help') {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (config.command === 'version') {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  if (config.http) {
    startHttpServer({
      apiUrl: config.apiUrl,
      fallbackApiKey: config.apiKey,
      port: config.httpPort,
      host: config.httpHost,
      allowedHosts: config.allowedHosts,
      apiTimeoutMs: config.apiTimeoutMs,
    });
    return;
  }

  if (!isVeltrixApiKey(config.apiKey)) {
    console.error(
      'VELTRIX_API_KEY is required in stdio mode and must be a Veltrix API key (vltx_...). Create a role-bound ' +
        'key in the Veltrix portal (Settings -> API Keys) and set it in your MCP client configuration.',
    );
    process.exit(1);
  }

  const server = buildMcpServer({ apiUrl: config.apiUrl, apiKey: config.apiKey, timeoutMs: config.apiTimeoutMs });
  await server.connect(new StdioServerTransport());
  // stdout belongs to the protocol in stdio mode — log to stderr only.
  console.error(`Veltrix MCP server ${SERVER_VERSION} running on stdio -> ${config.apiUrl}`);
}

main().catch((error) => {
  console.error('Veltrix MCP server failed to start:', error);
  process.exit(1);
});

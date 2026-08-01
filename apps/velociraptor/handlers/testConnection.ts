import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  resolveApiClientConfig,
  isApiClientConfigComplete,
  createVelociraptorClient,
  INFO_VQL,
} from '../lib/velociraptorApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever SDK the platform resolves.
interface TestConnectionContext {
  appId: string
  customerId: string
  endpoint: string | null
  credential: CredentialRef | null
  component: { hostname?: string | null } | null
  connectivity: unknown
  settings: Record<string, unknown>
}
interface TestConnectionResult {
  ok: boolean
  message: string
  details?: string[]
  latencyMs?: number
}

const TIMEOUT_MS = 10_000

/** Strip any scheme and trailing slash from a raw endpoint → host:port. */
function normalizeEndpoint(raw: string | null | undefined): string {
  return String(raw ?? '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/+$/, '')
}

// =============================================================================
// Velociraptor — connection test.
//
// Verifies a Connection's api-client config against the Velociraptor gRPC API
// (mutual TLS) by running `SELECT * FROM info()`. Rows back confirm the endpoint
// resolves AND the mTLS client cert authenticates.
//
// VERIFY against a live Velociraptor server: the gRPC service/method + info()
// (flagged in lib/velociraptorApi.ts + lib/velociraptor.proto).
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }

  const config = resolveApiClientConfig(ctx.credential, null, null)
  if (!config.apiConnectionString) config.apiConnectionString = normalizeEndpoint(ctx.endpoint)

  if (!config.caCertificate || !config.clientCert || !config.clientPrivateKey) {
    return {
      ok: false,
      message:
        'Velociraptor authenticates with an api-client config (CA cert + client cert + client key). Paste the full ' +
        'output of `velociraptor config api_client` into the connection secret.',
    }
  }
  if (!config.apiConnectionString) {
    return { ok: false, message: 'No API connection string is configured (host:port). Add it to the connection endpoint.' }
  }
  if (!isApiClientConfigComplete(config)) {
    return { ok: false, message: 'The api-client config is incomplete.' }
  }

  const started = Date.now()
  let client
  try {
    client = await createVelociraptorClient(config, { timeoutMs: TIMEOUT_MS })
  } catch (err) {
    return { ok: false, message: `Could not initialise the Velociraptor gRPC client: ${err instanceof Error ? err.message : String(err)}` }
  }

  try {
    const rows = await client.runVQL(INFO_VQL, { timeoutMs: TIMEOUT_MS, maxRows: 1 })
    const latencyMs = Date.now() - started
    if (rows.length === 0) {
      return { ok: false, message: 'Connected to Velociraptor but info() returned no rows.', details: [`Endpoint: ${config.apiConnectionString}`], latencyMs }
    }
    return {
      ok: true,
      message: 'Connected to Velociraptor over gRPC (info() returned).',
      details: [`Endpoint: ${config.apiConnectionString}`, 'Auth: api-client config (mutual TLS)'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/deadline|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${config.apiConnectionString}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns|name resolution/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${config.apiConnectionString}.`, latencyMs }
    if (/ECONNREFUSED|UNAVAILABLE|connect/i.test(msg)) return { ok: false, message: `Connection refused/unavailable at ${config.apiConnectionString}. Check the port and that the API server is listening.`, latencyMs }
    if (/certificate|ssl|tls|handshake/i.test(msg)) return { ok: false, message: `TLS/certificate error against ${config.apiConnectionString}: ${msg}. Check the api-client config matches the server.`, latencyMs }
    return { ok: false, message: `Could not reach ${config.apiConnectionString}: ${msg}`, latencyMs }
  } finally {
    await client.close().catch(() => {})
  }
}

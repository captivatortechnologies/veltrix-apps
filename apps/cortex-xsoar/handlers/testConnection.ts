import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildXsoarClient, resolveXsoarApiKey, xsoarErrorMessage, MISSING_CREDENTIAL_MESSAGE } from '../lib/xsoar'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves at load time.
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

// =============================================================================
// Cortex XSOAR — connection test.
//
// Verifies a Connection with a single authenticated GET /user against the XSOAR
// server. It proves the server URL is reachable and the API key (plus the
// x-xdr-auth-id header for XSOAR 8) is valid. Runs in-process with the decrypted
// key.
// =============================================================================

const PROBE_PATH = '/user'

function classifyProbeError(err: unknown, serverUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Cortex XSOAR at ${serverUrl}. Check the server URL and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${serverUrl}. Check the server URL.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${serverUrl}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${serverUrl}: ${msg}`
  return `Could not reach Cortex XSOAR (${serverUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set the Cortex XSOAR server URL on the connection.',
    }
  }
  if (!resolveXsoarApiKey(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildXsoarClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, serverUrl } = built
  const details = [`Server: ${serverUrl}`, `Auth: API key${client.isXsoar8 ? ' + x-xdr-auth-id (XSOAR 8)' : ' (XSOAR 6.x)'}`]
  const started = Date.now()

  try {
    const res = await client.request('GET', PROBE_PATH)
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message:
          `Cortex XSOAR rejected the API key (HTTP ${res.status}). Check the key value` +
          (client.isXsoar8 ? ', the "API Key ID" (auth_id) setting,' : '') +
          ' and that the key is not expired.',
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message:
          `Cortex XSOAR API endpoint not found (404) at ${serverUrl}. Check the server URL` +
          (client.isXsoar8 ? ' and the API base path (XSOAR 8 uses the /xsoar gateway path).' : '.'),
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Cortex XSOAR (${serverUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Cortex XSOAR API returned HTTP ${res.status}: ${xsoarErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, serverUrl), details, latencyMs: Date.now() - started }
  }
}

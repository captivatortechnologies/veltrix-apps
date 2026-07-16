import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage, resolveS1Token, MISSING_CREDENTIAL_MESSAGE } from '../lib/s1'

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
// SentinelOne — connection test.
//
// Verifies a Connection with a single authenticated GET /system/info against the
// management console. It proves the console URL is reachable and the API token
// is valid. Runs in-process with the decrypted token.
// =============================================================================

const PROBE_PATH = '/system/info'

function classifyProbeError(err: unknown, consoleUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching the SentinelOne console at ${consoleUrl}. Check the console URL and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${consoleUrl}. Check the console URL.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${consoleUrl}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${consoleUrl}: ${msg}`
  return `Could not reach the SentinelOne console (${consoleUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set the SentinelOne management console URL on the connection.',
    }
  }
  if (!resolveS1Token(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildS1Client(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, consoleUrl } = built
  const details = [`Console: ${consoleUrl}`, 'Auth: API token']
  const started = Date.now()

  try {
    const res = await client.request('GET', PROBE_PATH)
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `SentinelOne rejected the API token (HTTP ${res.status}). Check the token value and that it is not expired.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `SentinelOne API endpoint not found (404) at ${consoleUrl}. Check the console URL.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to SentinelOne (${consoleUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `SentinelOne API returned HTTP ${res.status}: ${s1ErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, consoleUrl), details, latencyMs: Date.now() - started }
  }
}

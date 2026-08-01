import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildRecordedFutureClient,
  recordedFutureErrorMessage,
  resolveRecordedFutureToken,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/recordedFutureApi'

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
// Recorded Future — connection test.
//
// Verifies a Connection with a single authenticated request against the List API:
// POST https://api.recordedfuture.com/list/search { limit: 1 }. It proves the API
// host is reachable and the API token (X-RFToken) is valid and List-API-entitled.
// Runs in-process with the decrypted credential.
// =============================================================================

function classifyProbeError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Recorded Future at ${baseUrl}. Check network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${baseUrl}. Check the Recorded Future API host.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${baseUrl}: ${msg}.`
  return `Could not reach Recorded Future (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveRecordedFutureToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const endpoint = (ctx.endpoint || ctx.component?.hostname || '').trim()
  const built = buildRecordedFutureClient(ctx.credential, ctx.settings, endpoint)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built
  const details = [`API host: ${baseUrl}`, 'Auth: X-RFToken']
  const started = Date.now()

  try {
    const res = await client.health()
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Recorded Future rejected the token (HTTP ${res.status}). Check the API token and that it is scoped to the List API.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Recorded Future (${baseUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Recorded Future API returned HTTP ${res.status}: ${recordedFutureErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, baseUrl), details, latencyMs: Date.now() - started }
  }
}

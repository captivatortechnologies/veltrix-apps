import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildVisionOneClient,
  visionOneErrorMessage,
  resolveVisionOneToken,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/visionOneApi'

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
// Trend Micro Vision One — connection test.
//
// Verifies a Connection with a single authenticated request against the public
// API: GET /v3.0/threatintel/suspiciousObjects?top=1. It proves the regional API
// host is reachable and the API token (Bearer) is valid. Runs in-process with the
// decrypted credential.
// =============================================================================

function classifyProbeError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Trend Vision One at ${baseUrl}. Check the regional API host and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${baseUrl}. Check the Trend Vision One regional API host (e.g. api.xdr.trendmicro.com).`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}. Check the Trend Vision One regional API host.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${baseUrl}: ${msg}.`
  return `Could not reach Trend Vision One (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message:
        'No endpoint is configured for this connection. Set the Trend Vision One regional API host ' +
        '(e.g. api.xdr.trendmicro.com for the US, api.eu.xdr.trendmicro.com for Europe) on the connection.',
    }
  }
  if (!resolveVisionOneToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildVisionOneClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built
  const details = [`Region host: ${baseUrl}`, 'Auth: Bearer API token']
  const started = Date.now()

  try {
    const res = await client.health()
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Trend Vision One rejected the credential (HTTP ${res.status}). Check the API token and that its role grants Suspicious Object List access.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Trend Vision One (${baseUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Trend Vision One API returned HTTP ${res.status}: ${visionOneErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, baseUrl), details, latencyMs: Date.now() - started }
  }
}

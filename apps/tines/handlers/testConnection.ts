import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildTinesClient,
  tinesErrorMessage,
  resolveTinesToken,
  MISSING_CREDENTIAL_MESSAGE,
  MISSING_COMPONENT_MESSAGE,
} from '../lib/tinesApi'

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
// Tines — connection test.
//
// Verifies a Connection's tenant domain + API key by calling GET /api/v1/teams
// (the cheapest authenticated list endpoint). A 2xx confirms both the host and
// the key; a 401/403 proves the host resolves but flags the key.
// =============================================================================

function classifyProbeError(err: unknown, host: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching ${host}. Check network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve the Tines tenant host (${host}).`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${host}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${host}: ${msg}`
  return `Could not reach ${host}: ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveTinesToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const hostname = ctx.component?.hostname ?? ctx.endpoint ?? undefined
  if (!hostname) {
    return { ok: false, message: MISSING_COMPONENT_MESSAGE }
  }

  const built = buildTinesClient(hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client } = built
  const details = [`Endpoint: ${client.apiBase}`, 'Auth: API key (Bearer)']
  const started = Date.now()

  try {
    const res = await client.request('GET', '/teams', { query: { per_page: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Tines rejected the API key (HTTP ${res.status}). Check the key value and that it hasn't been revoked.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: 'Connected to Tines (API key verified).', details, latencyMs }
    }
    return { ok: false, message: `Tines API returned HTTP ${res.status}: ${tinesErrorMessage(res)}`, details, latencyMs }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, hostname), details, latencyMs: Date.now() - started }
  }
}

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  resolvePagerDutyToken,
  MISSING_CREDENTIAL_MESSAGE,
  BASE_URL,
} from '../lib/pagerdutyApi'

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
// PagerDuty — connection test.
//
// Verifies a Connection's REST API key by calling GET /abilities at the fixed
// https://api.pagerduty.com base. A 2xx confirms the key authenticates; a 401/403
// proves reachability but flags the key. The base URL is fixed for every account,
// so no endpoint/host is required — only the API key.
// =============================================================================

function classifyProbeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return 'Timed out reaching the PagerDuty API. Check network reachability.'
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return 'Could not resolve the PagerDuty API host (api.pagerduty.com).'
  if (/ECONNREFUSED/i.test(msg)) return 'Connection refused by the PagerDuty API.'
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching the PagerDuty API: ${msg}`
  return `Could not reach the PagerDuty API: ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolvePagerDutyToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client } = built
  const details = [`Endpoint: ${BASE_URL}`, 'Auth: REST API key']
  const started = Date.now()

  try {
    const res = await client.request('GET', '/abilities')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `PagerDuty rejected the API key (HTTP ${res.status}). Check the key value and that it is a REST API key.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: 'Connected to PagerDuty (REST API key verified).', details, latencyMs }
    }
    return { ok: false, message: `PagerDuty API returned HTTP ${res.status}: ${pagerDutyErrorMessage(res)}`, details, latencyMs }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err), details, latencyMs: Date.now() - started }
  }
}

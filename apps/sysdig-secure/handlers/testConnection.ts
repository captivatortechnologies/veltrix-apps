import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, FALCO_RULE_TYPE } from '../lib/sysdigApi'

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

// A harmless authenticated probe against the exact API surface this app writes
// to: a rule-group lookup for a name that will not exist returns 200 with an
// empty array, proving the token authenticates AND the Secure rules API is
// reachable.
const PROBE_NAME = 'veltrix-sysdig-secure-connectivity-probe'

// =============================================================================
// Sysdig Secure — connection test.
//
// Verifies a Connection's region base URL + API token by calling the Sysdig
// Secure REST API (GET /api/secure/rules/groups, Bearer auth over HTTPS). A 200
// confirms the endpoint resolves AND the token authenticates; a 401/403 proves
// reachability but flags the token.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const endpoint = ctx.endpoint || ctx.component?.hostname || null

  const built = buildSysdigClient(endpoint, ctx.credential, ctx.settings ?? {})
  if ('error' in built) return { ok: false, message: built.error }
  const { client, baseUrl } = built
  const details = [`Endpoint: ${baseUrl}`, 'Auth: Bearer API token']

  const started = Date.now()
  try {
    const res = await client.request('GET', '/api/secure/rules/groups', {
      query: { name: PROBE_NAME, type: FALCO_RULE_TYPE },
    })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Sysdig Secure but authentication failed (HTTP ${res.status}). Check the API token.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Sysdig Secure rules API not found (404) at ${baseUrl}. Check the region base URL.`,
        details,
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Sysdig Secure returned HTTP ${res.status}.`, details, latencyMs }
    }
    return { ok: true, message: `Connected to Sysdig Secure (${baseUrl}).`, details, latencyMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out connecting to ${baseUrl}.`, details, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${baseUrl}.`, details, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${baseUrl}.`, details, latencyMs }
    return { ok: false, message: `Could not reach ${baseUrl}: ${msg}`, details, latencyMs }
  }
}

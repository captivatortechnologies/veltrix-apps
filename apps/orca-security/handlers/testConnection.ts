import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, resolveOrcaToken, MISSING_CREDENTIAL_MESSAGE } from '../lib/orcaApi'

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
// Orca Security — connection test.
//
// Verifies a Connection with a single authenticated read against the Orca REST
// API (GET /api/alerts/catalog/category). It proves the endpoint is reachable
// and the API token is accepted. Runs in-process with the decrypted credential.
// =============================================================================

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveOrcaToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const host = (ctx.endpoint || ctx.component?.hostname || '') as string
  const built = buildOrcaClient(host || null, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built
  const details = [`Endpoint: ${baseUrl}`, 'Auth: API token (Authorization: Token …)']
  const started = Date.now()

  const res = await client.request('GET', '/api/alerts/catalog/category')
  const latencyMs = Date.now() - started

  if (res.ok) {
    return { ok: true, message: `Connected to Orca (${baseUrl}).`, details, latencyMs }
  }
  return { ok: false, message: classifyError(res.error, res.status, baseUrl), details, latencyMs }
}

/** Turn a transport/HTTP error into an operator-actionable message. */
function classifyError(message: string | null, status: number, baseUrl: string): string {
  const m = message ?? `HTTP ${status}`
  if (status === 401 || status === 403 || /HTTP 40[13]\b/.test(m)) {
    return `Orca rejected the API token (HTTP ${status || '401/403'}). Check the token and its permissions in Settings > Users & Permissions > API.`
  }
  if (status === 404 || /HTTP 404\b/.test(m)) {
    return `Orca API endpoint not found (404) at ${baseUrl}. Check the regional host (api.orcasecurity.io or api.eu.orcasecurity.io).`
  }
  if (/abort|timed?\s?out/i.test(m)) {
    return `Timed out reaching Orca at ${baseUrl}. Check the endpoint and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(m)) {
    return `Could not resolve ${baseUrl}. Check the regional Orca API host.`
  }
  if (/ECONNREFUSED/i.test(m)) {
    return `Connection refused by ${baseUrl}.`
  }
  return `Could not reach Orca (${baseUrl}): ${m}`
}

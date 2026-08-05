import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage } from '../lib/f5xc'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves when it loads the
// handler - older SDKs predate these type exports. Only long-standing types
// (CredentialRef) are imported.
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
// F5 Distributed Cloud - connection test.
//
// Verifies a Connection by listing the healthchecks collection in the
// connection's namespace: GET /api/config/namespaces/{namespace}/healthchecks.
// A 200 (even with zero items) proves the API Token is valid AND the
// namespace exists; 401/403 means the token was rejected; 404 means the
// namespace itself does not exist on this tenant. Runs in-process on the
// platform with the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching F5 Distributed Cloud at ${baseUrl}. Check the tenant hostname and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${baseUrl}. Check the tenant console hostname.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  return `Could not reach F5 Distributed Cloud (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const hostname = ctx.endpoint || ctx.component?.hostname || ''
  const built = buildF5xcClient(hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, tenantHost, namespace } = built
  const baseUrl = `https://${tenantHost}/api/config/namespaces/${namespace}`

  const started = Date.now()
  try {
    const res = await client.request('GET', '/healthchecks')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `F5 Distributed Cloud rejected the API Token (HTTP ${res.status}). Check the credential's API token value and that it has not expired.`,
        details: [`Target: ${baseUrl}`, 'Auth: API Token (Authorization: APIToken <token>)'],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Namespace "${namespace}" was not found on tenant ${tenantHost} (404). Check the F5 XC Namespace app setting.`,
        details: [`Target: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      return {
        ok: true,
        message: `Connected to F5 Distributed Cloud tenant "${tenantHost}", namespace "${namespace}".`,
        details: [`Target: ${baseUrl}`, 'Auth: API Token (Authorization: APIToken <token>)'],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `F5 Distributed Cloud returned HTTP ${res.status}: ${f5xcErrorMessage(res)}`,
      details: [`Target: ${baseUrl}`],
      latencyMs,
    }
  } catch (error) {
    return {
      ok: false,
      message: classifyNetworkError(error, baseUrl),
      details: [`Target: ${baseUrl}`],
      latencyMs: Date.now() - started,
    }
  }
}

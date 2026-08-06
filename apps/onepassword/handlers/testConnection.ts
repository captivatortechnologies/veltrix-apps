import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient, parseJson, scimErrorMessage } from '../lib/onePassword'

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
// 1Password - connection test.
//
// Verifies a Connection with the bridge's own status endpoint:
//   GET /health   Authorization: Bearer <token>
// Confirmed live against 1Password's own deployment guide
// (github.com/1Password/scim-examples, kubernetes/README.md, "Step 5: Test
// your SCIM bridge") - a 2xx with every `reports[].state` == "healthy"
// confirms the bridge resolves, the token is valid, AND its own dependencies
// (Redis cache, SCIM server, confirmation/provisioning watchers) are up.
// Runs in-process on the platform with the decrypted credential.
// =============================================================================

interface HealthReport {
  build?: string
  version?: string
  reports?: Array<{ source?: string; state?: string }>
}

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching the 1Password SCIM Bridge at ${baseUrl}. Check the address and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${baseUrl}. Check the SCIM Bridge address.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}. Check the SCIM Bridge address and port.`
  if (/self.signed|certificate|CERT_|ERR_TLS|DEPTH_ZERO|unable to verify|SSL/i.test(msg)) {
    return `TLS error reaching ${baseUrl}: ${msg}. Check the SCIM Bridge's certificate.`
  }
  return `Could not reach the 1Password SCIM Bridge (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const hostname = ctx.endpoint || ctx.component?.hostname || ''
  const built = buildOnePasswordClient(hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built

  const started = Date.now()
  try {
    const res = await client.request('GET', '/health')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `The SCIM Bridge rejected the bearer token (HTTP ${res.status}).`,
        details: [`Target: ${baseUrl}`, 'Auth: Bearer token'],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `No SCIM Bridge found at ${baseUrl} (404). Check the address - it should have no trailing path (not /scim/v2).`,
        details: [`Target: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      const health = parseJson<HealthReport>(res.body)
      const reports = health?.reports ?? []
      const unhealthy = reports.filter((r) => r.state && r.state !== 'healthy')
      if (unhealthy.length > 0) {
        return {
          ok: false,
          message: `Connected to the SCIM Bridge at ${baseUrl}, but ${unhealthy.length} subsystem(s) are unhealthy: ${unhealthy
            .map((r) => `${r.source ?? 'unknown'}=${r.state}`)
            .join(', ')}.`,
          details: [`Target: ${baseUrl}`, `Bridge version: ${health?.version ?? 'unknown'}`],
          latencyMs,
        }
      }
      return {
        ok: true,
        message: `Connected to the 1Password SCIM Bridge at ${baseUrl}${health?.version ? ` (v${health.version})` : ''}.`,
        details: [`Target: ${baseUrl}`, 'Auth: Bearer token', `Subsystems healthy: ${reports.length || 'unreported'}`],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `The SCIM Bridge returned HTTP ${res.status}: ${scimErrorMessage(res)}`,
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

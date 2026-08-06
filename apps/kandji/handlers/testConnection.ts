import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildKandjiClient, resolveKandjiToken, MISSING_CREDENTIAL_MESSAGE } from '../lib/kandjiApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves at load time.
interface TestConnectionContext {
  appId: string
  customerId: string
  endpoint: string | null
  credential: CredentialRef | null
  component: { hostname?: string | null; port?: string | null } | null
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
// Kandji — connection test.
//
// Verifies a Connection by calling GET /api/v1/settings/licensing (tenant
// licensing/utilization info, read-only, no query parameters). This proves
// the tenant host is reachable and the Bearer API token is accepted, without
// depending on any Blueprint/Library item already existing in the tenant.
// Runs in-process with the decrypted credential.
// =============================================================================

interface LicensingResponse {
  counts?: { computers_count?: number }
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set your Kandji tenant API URL (e.g. yourcompany.api.kandji.io).',
    }
  }
  if (!resolveKandjiToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildKandjiClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built
  const details = [`Endpoint: ${baseUrl}`, 'Auth: Bearer API token']
  const started = Date.now()

  try {
    const res = await client.request<LicensingResponse>('GET', '/api/v1/settings/licensing')
    const latencyMs = Date.now() - started

    if (res.error) {
      return { ok: false, message: classifyTransportError(res.error, res.status, baseUrl), details, latencyMs }
    }
    const computers = res.data?.counts?.computers_count
    return {
      ok: true,
      message: `Connected to Kandji (${baseUrl}).${typeof computers === 'number' ? ` ${computers} device(s) enrolled.` : ''}`,
      details,
      latencyMs,
    }
  } catch (err) {
    const latencyMs = Date.now() - started
    return { ok: false, message: classifyTransportError(err instanceof Error ? err.message : String(err), 0, baseUrl), details, latencyMs }
  }
}

/** Turn a transport-level error into an operator-actionable message. */
function classifyTransportError(message: string, status: number, baseUrl: string): string {
  if (status === 401 || /HTTP 401\b/.test(message)) {
    return `Kandji rejected the API token (HTTP 401) — check that it was copied correctly and has not been revoked.`
  }
  if (status === 403 || /HTTP 403\b/.test(message)) {
    return `Kandji rejected the request (HTTP 403). Verify the API token's role grants access to Settings.`
  }
  if (status === 404 || /HTTP 404\b/.test(message)) {
    return `Kandji API endpoint not found (404) at ${baseUrl}. Check the tenant host — copy it verbatim from Settings > Access.`
  }
  if (/abort|timed?\s?out/i.test(message)) {
    return `Timed out reaching Kandji at ${baseUrl}. Check the endpoint and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) {
    return `Could not resolve ${baseUrl}. Check the Kandji tenant host (e.g. yourcompany.api.kandji.io).`
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `Connection refused by ${baseUrl}.`
  }
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) {
    return `TLS/certificate error reaching ${baseUrl}: ${message}`
  }
  return `Could not reach Kandji (${baseUrl}): ${message}`
}

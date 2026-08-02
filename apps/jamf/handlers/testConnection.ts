import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildApiBase, buildJamfClient, resolveJamfCredentials, MISSING_CREDENTIAL_MESSAGE } from '../lib/jamfApi'

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
// Jamf Pro — connection test.
//
// Verifies a Connection by obtaining a Bearer token (Basic auth, POST
// /v1/auth/token) and then calling GET /v1/scripts?page-size=1. This proves
// the endpoint is reachable, the API-only account's credentials are accepted,
// and the account holds at least the "Read Scripts" privilege this app needs.
// Runs in-process with the decrypted credential.
// =============================================================================

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set your Jamf Pro server host (e.g. yourcompany.jamfcloud.com).',
    }
  }
  if (!resolveJamfCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildJamfClient({ hostname: host, port: ctx.component?.port ?? undefined }, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, apiBase } = built
  const details = [`Endpoint: ${apiBase}`, 'Auth: Basic (API-only account) → Bearer token']
  const started = Date.now()

  try {
    const res = await client.request('GET', '/v1/scripts?page-size=1')
    const latencyMs = Date.now() - started

    if (res.error) {
      return { ok: false, message: classifyTransportError(res.error, res.status, apiBase), details, latencyMs }
    }
    return { ok: true, message: `Connected to Jamf Pro (${apiBase}).`, details, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    return { ok: false, message: classifyTransportError(err instanceof Error ? err.message : String(err), 0, apiBase), details, latencyMs }
  }
}

/** Turn a transport-level error into an operator-actionable message. */
function classifyTransportError(message: string, status: number, apiBase: string): string {
  if (/token request failed/i.test(message)) {
    return `Jamf Pro rejected the API-only account credentials — check the username and password, and that the account is not locked or forced to change its password. (${message})`
  }
  if (status === 401 || status === 403 || /HTTP 40[13]\b/.test(message)) {
    return `Jamf Pro rejected the request (HTTP ${status || '401/403'}). Verify the account holds the "Read Scripts" privilege.`
  }
  if (status === 404 || /HTTP 404\b/.test(message)) {
    return `Jamf Pro API endpoint not found (404) at ${apiBase}. Check the server host (and port, for an on-prem install).`
  }
  if (/abort|timed?\s?out/i.test(message)) {
    return `Timed out reaching Jamf Pro at ${apiBase}. Check the endpoint and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) {
    return `Could not resolve ${apiBase}. Check the Jamf Pro server host.`
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `Connection refused by ${apiBase}.`
  }
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) {
    return `TLS/certificate error reaching ${apiBase}: ${message}`
  }
  return `Could not reach Jamf Pro (${apiBase}): ${message}`
}

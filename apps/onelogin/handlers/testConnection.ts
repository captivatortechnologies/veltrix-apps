import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, parseJson, oneLoginErrorMessage } from '../lib/oneLogin'

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
// OneLogin - connection test.
//
// Verifies a Connection by (1) minting an API-credential access token - POST
// {domain}/auth/oauth2/v2/token with the client_credentials grant - which
// proves the Client ID/Secret and account domain are correct together, then
// (2) confirming the token can list Apps via GET /api/2/apps?limit=1. Runs
// in-process on the platform with the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching OneLogin at ${baseUrl}. Check the account domain and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${baseUrl}. Check the OneLogin subdomain.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  return `Could not reach OneLogin (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const hostname = ctx.endpoint || ctx.component?.hostname || ''
  const built = buildOneLoginClient(hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, domain } = built
  const baseUrl = `https://${domain}`

  const started = Date.now()
  try {
    const res = await client.request('GET', '/api/2/apps', { query: { limit: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `OneLogin rejected the API credentials or denied access (HTTP ${res.status}). Check the Client ID/Secret and its scope.`,
        details: [`Target: ${baseUrl}`, 'Auth: API credential (client_credentials)'],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Account domain ${domain} was not found (404). Check the OneLogin subdomain.`,
        details: [`Target: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      const apps = parseJson<unknown[]>(res.body)
      const count = Array.isArray(apps) ? apps.length : 0
      return {
        ok: true,
        message: `Connected to OneLogin (${domain}).`,
        details: [`Target: ${baseUrl}`, `Auth: API credential (client_credentials)`, `Apps visible: ${count > 0 ? 'yes' : '0 in this page'}`],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `OneLogin returned HTTP ${res.status}: ${oneLoginErrorMessage(res)}`,
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

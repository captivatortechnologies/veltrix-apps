import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson } from '../lib/okta'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves when it loads the
// handler — older SDKs predate these type exports. Only long-standing types
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
// Okta — connection test.
//
// Verifies a Connection by calling the Okta Management API with the SSWS API
// token: `GET /api/v1/org`. A 2xx confirms the org domain resolves AND the token
// authenticates with admin read; 401/403 = bad/expired token, 404 = wrong org
// domain. Runs in-process on the platform with the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Okta at ${baseUrl}. Check the org domain and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${baseUrl}. Check the Okta org domain (e.g. dev-12345.okta.com).`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  return `Could not reach Okta (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No Okta org domain is configured for this connection (e.g. dev-12345.okta.com).',
    }
  }

  // Reuse the client builder — it resolves the SSWS token, normalizes the org
  // domain to https://<org>/api/v1 and applies the request-timeout setting.
  const built = buildOktaClient(host, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client, baseUrl } = built

  const started = Date.now()
  try {
    const res = await client.request('GET', '/org')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Okta rejected the API token (HTTP ${res.status}). Check the SSWS token and its admin permissions.`,
        details: [`Endpoint: ${baseUrl}`, 'Auth: SSWS API token'],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Okta org was not found at ${baseUrl} (404). Check the org domain (e.g. dev-12345.okta.com).`,
        details: [`Endpoint: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      const org = parseJson<{ companyName?: string; subdomain?: string }>(res.body)
      const who = org?.companyName || org?.subdomain
      return {
        ok: true,
        message: `Connected to Okta${who ? ` org "${who}"` : ''}.`,
        details: [`Endpoint: ${baseUrl}`, ...(who ? [`Org: ${who}`] : []), 'Auth: SSWS API token'],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `Okta returned HTTP ${res.status}: ${oktaErrorMessage(res)}`,
      details: [`Endpoint: ${baseUrl}`],
      latencyMs,
    }
  } catch (err) {
    return {
      ok: false,
      message: classifyNetworkError(err, baseUrl),
      details: [`Endpoint: ${baseUrl}`],
      latencyMs: Date.now() - started,
    }
  }
}

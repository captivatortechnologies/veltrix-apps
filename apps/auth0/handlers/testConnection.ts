import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  auth0Fetch,
  bearer,
} from '../lib/auth0Api'

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

const TIMEOUT_MS = 10_000

// =============================================================================
// Auth0 — connection test.
//
// Verifies a Connection's tenant domain + Machine-to-Machine credential by (1)
// minting a Management API access token via the client-credentials grant and (2)
// calling GET /api/v2/clients?per_page=1. A successful token + 2xx read confirms
// the domain resolves, the Client ID/Secret authenticate, and the M2M grant has
// read:clients; a token failure flags the credential, and a 403 on the read
// proves auth worked but the grant lacks read:clients.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const rawDomain = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!rawDomain) return { ok: false, message: 'No tenant domain is configured for this connection.' }

  const creds = resolveClientCredentials(ctx.credential)
  if (!creds) {
    return { ok: false, message: 'Auth0 authenticates with a Machine-to-Machine Client ID and Client Secret — attach both to this connection.' }
  }

  const domain = resolveDomain({ hostname: rawDomain } as never, null)
  const base = buildApiBase(domain)
  const started = Date.now()

  let accessToken: string
  try {
    accessToken = (await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret, timeoutMs: TIMEOUT_MS })).accessToken
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${domain}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the tenant domain "${domain}".`, latencyMs }
    return {
      ok: false,
      message: `Reached Auth0 but could not mint a Management API token — check the Client ID / Client Secret and that the app is authorized for the Management API.`,
      details: [`Domain: ${domain}`, msg],
      latencyMs,
    }
  }

  try {
    const res = await auth0Fetch(`${base}/clients?per_page=1`, { headers: bearer(accessToken), timeoutMs: TIMEOUT_MS })
    const latencyMs = Date.now() - started
    if (res.status === 403) {
      return {
        ok: false,
        message: 'Authenticated with Auth0, but the M2M application is missing the read:clients scope.',
        details: [`Domain: ${domain}`, 'Grant read:clients (and create/update/delete:clients to deploy)'],
        latencyMs,
      }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Auth0 Management API returned HTTP ${res.status}.`, details: [`Domain: ${domain}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Auth0 (HTTP ${res.status}).`,
      details: [`Domain: ${domain}`, 'Auth: Machine-to-Machine client credentials'],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${domain}.`, latencyMs }
    return { ok: false, message: `Could not reach the Auth0 Management API: ${msg}`, latencyMs }
  }
}

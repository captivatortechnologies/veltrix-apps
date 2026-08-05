import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildAquaClient } from '../lib/aquasec'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever @veltrixsecops/app-sdk
// version the platform resolves at load time. Only long-standing types
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
// Aqua Security — connection test.
//
// Verifies a Connection's Aqua Console base URL + user credential by logging
// in (POST /api/v1/login) and then calling the exact API surface this app's
// config types write to (GET /api/v2/access_management/scopes/<probe>). A 200
// or 404 confirms the endpoint resolves AND the credential authenticates; a
// 401/403 proves reachability but flags the credential.
// =============================================================================

const PROBE_NAME = 'veltrix-aqua-security-connectivity-probe'

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const endpoint = ctx.endpoint || ctx.component?.hostname || null

  const built = buildAquaClient(endpoint, ctx.credential, ctx.settings ?? {})
  if ('error' in built) return { ok: false, message: built.error }
  const { client, baseUrl } = built
  const details = [`Console: ${baseUrl}`, 'Auth: Aqua user session login (POST /api/v1/login)']

  const started = Date.now()
  try {
    const res = await client.request('GET', `/api/v2/access_management/scopes/${PROBE_NAME}`)
    const latencyMs = Date.now() - started

    if (res.status === 0) {
      // login itself failed before any REST call was made — res.body carries the reason.
      return { ok: false, message: res.body || 'Could not log in to the Aqua Console.', details, latencyMs }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached the Aqua Console but authentication failed (HTTP ${res.status}). Check the Aqua user/password.`,
        details,
        latencyMs,
      }
    }
    if (res.status >= 500) {
      return { ok: false, message: `Aqua Console returned HTTP ${res.status}.`, details, latencyMs }
    }
    // 200 (probe name coincidentally exists) or 404 (does not exist) both prove
    // the Console resolved and the credential authenticated.
    return { ok: true, message: `Connected to the Aqua Console (${baseUrl}).`, details, latencyMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out connecting to ${baseUrl}.`, details, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${baseUrl}.`, details, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${baseUrl}.`, details, latencyMs }
    return { ok: false, message: `Could not reach ${baseUrl}: ${msg}`, details, latencyMs }
  }
}

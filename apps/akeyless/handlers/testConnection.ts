import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, parseJson, akeylessErrorMessage } from '../lib/akeyless'

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
// Akeyless - connection test.
//
// Verifies a Connection by (1) exchanging the Access ID/Key for a short-lived
// token via POST /auth, which proves the credential is valid, then (2)
// confirming the token can list Roles via POST /list-roles - a lightweight,
// low-privilege metadata call every associated role can make. Runs
// in-process on the platform with the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching Akeyless at ${baseUrl}. Check the API/Gateway URL and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${baseUrl}. Check the API/Gateway URL.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  return `Could not reach Akeyless (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const endpoint = ctx.endpoint || ctx.component?.hostname || ''
  const built = buildAkeylessClient(endpoint, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built

  const started = Date.now()
  try {
    const res = await client.request('/list-roles')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Akeyless rejected the credentials or denied access (HTTP ${res.status}). Check the Access ID/Key and its role's permissions.`,
        details: [`Target: ${baseUrl}`, 'Auth: API Key (access-id/access-key)'],
        latencyMs,
      }
    }
    if (res.ok) {
      const parsed = parseJson<{ roles?: unknown[] }>(res.body)
      const count = Array.isArray(parsed?.roles) ? parsed!.roles!.length : 0
      return {
        ok: true,
        message: `Connected to Akeyless (${baseUrl}).`,
        details: [`Target: ${baseUrl}`, 'Auth: API Key (access-id/access-key)', `Roles visible: ${count}`],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `Akeyless returned HTTP ${res.status}: ${akeylessErrorMessage(res)}`,
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

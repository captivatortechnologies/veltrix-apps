import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, parseJson, teleportErrorMessage } from '../lib/teleport'

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
// Teleport - connection test.
//
// Logs in via POST /v1/webapi/sessions/web (username/password + TOTP, if
// configured) exactly like the Teleport Web UI's own login form, then
// confirms the resulting session can list clusters via GET /v1/webapi/sites -
// a lightweight, always-available call that proves the credentials and
// Proxy address are correct together. Runs in-process on the platform with
// the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching Teleport at ${baseUrl}. Check the Proxy address and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${baseUrl}. Check the Teleport Proxy address.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  return `Could not reach Teleport (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const hostname = ctx.endpoint || ctx.component?.hostname || ''
  const built = buildTeleportClient(hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built

  const started = Date.now()
  try {
    const res = await client.request('GET', '/v1/webapi/sites')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Teleport rejected the login or denied access (HTTP ${res.status}). Check the username, password, and TOTP seed.`,
        details: [`Target: ${baseUrl}`, 'Auth: local user (username/password + TOTP)'],
        latencyMs,
      }
    }
    if (res.ok) {
      const sites = parseJson<Array<{ name?: string }>>(res.body) ?? []
      const clusterName = sites[0]?.name
      return {
        ok: true,
        message: `Connected to Teleport${clusterName ? ` (cluster "${clusterName}")` : ''}.`,
        details: [`Target: ${baseUrl}`, ...(clusterName ? [`Cluster: ${clusterName}`] : []), 'Auth: local user (username/password + TOTP)'],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `Teleport returned HTTP ${res.status}: ${teleportErrorMessage(res)}`,
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

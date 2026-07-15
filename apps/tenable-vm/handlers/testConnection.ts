import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildTenableClient, parseJson, tenableErrorMessage } from '../lib/tenable'

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
// Tenable Vulnerability Management (tenable.io) — connection test.
//
// Verifies a Connection by calling the Tenable API with the stored key pair:
// `GET /session` (the current-user record — this REQUIRES auth, unlike the public
// /server/status readiness endpoint, so it actually validates the keys). A 2xx
// confirms the endpoint resolves AND the access/
// secret keys authenticate; 401/403 = bad keys, 404 = wrong endpoint. Auth is a
// static key pair sent as `X-ApiKeys: accessKey=<access>; secretKey=<secret>`,
// where the access key lives in the credential's "username" field and the secret
// key in its "API token" field. Runs in-process on the platform with the
// decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Tenable at ${baseUrl}. Check the endpoint and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${baseUrl}. Check the API base URL / endpoint.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  return `Could not reach Tenable (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || 'cloud.tenable.com').trim()

  // buildTenableClient resolves the key pair (access key in "username", secret
  // key in "API token"), normalizes the host to an https:// base URL, and applies
  // the app's timeout setting — reusing the exact wiring the config-type handlers
  // rely on. A missing/incomplete key pair short-circuits to a failure here.
  const built = buildTenableClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built

  const started = Date.now()
  try {
    const res = await client.request('GET', '/session')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Tenable rejected the API keys (HTTP ${res.status}). Check the access/secret key pair.`,
        details: [`Endpoint: ${baseUrl}`, 'Auth: X-ApiKeys (access + secret key)'],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Tenable endpoint not found (404). Check the API base URL / endpoint.`,
        details: [`Endpoint: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      const user = parseJson<{ username?: string; name?: string }>(res.body)
      const who = user?.username || user?.name
      return {
        ok: true,
        message: `Connected to Tenable Vulnerability Management at ${baseUrl}.`,
        details: [
          `Endpoint: ${baseUrl}`,
          'Auth: X-ApiKeys (access + secret key)',
          ...(who ? [`Authenticated as: ${who}`] : []),
        ],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `Tenable returned HTTP ${res.status}.`,
      details: [`Endpoint: ${baseUrl}`, `Response: ${tenableErrorMessage(res).slice(0, 200)}`],
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

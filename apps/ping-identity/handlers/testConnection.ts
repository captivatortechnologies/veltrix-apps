import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage } from '../lib/pingOne'

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
// PingOne - connection test.
//
// Verifies a Connection by (1) minting a worker access token - POST
// {authBaseUrl}/{environmentId}/as/token with the client_credentials grant -
// which proves the worker Client ID/Secret, region and environment id are all
// correct together, then (2) confirming the token can read the environment via
// GET /v1/environments/{environmentId}. Runs in-process on the platform with
// the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching PingOne at ${baseUrl}. Check the region and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${baseUrl}. Check the selected PingOne region.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  return `Could not reach PingOne (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const hostname = ctx.endpoint || ctx.component?.hostname || ''
  const built = buildPingOneClient(hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, environmentId, region } = built
  const baseUrl = `environment ${environmentId} (region ${region})`

  const started = Date.now()
  try {
    const res = await client.request('GET', '')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `PingOne rejected the worker credentials or denied access (HTTP ${res.status}). Check the worker Client ID/Secret and its role assignment.`,
        details: [`Target: ${baseUrl}`, 'Auth: worker application (client_credentials)'],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Environment ${environmentId} was not found in region ${region} (404). Check the Environment ID and the selected region.`,
        details: [`Target: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      const env = parseJson<{ name?: string }>(res.body)
      const who = env?.name
      return {
        ok: true,
        message: `Connected to PingOne${who ? ` environment "${who}"` : ''}.`,
        details: [`Target: ${baseUrl}`, ...(who ? [`Environment: ${who}`] : []), 'Auth: worker application (client_credentials)'],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `PingOne returned HTTP ${res.status}: ${pingOneErrorMessage(res)}`,
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

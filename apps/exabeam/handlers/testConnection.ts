import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildExabeamClient, exabeamErrorMessage } from '../lib/exabeam'

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
// Exabeam - connection test.
//
// Verifies a Connection by (1) minting an API Key access token - POST
// {baseUrl}/auth/v1/token with the client_credentials grant - which proves the
// API Key/Secret and region are correct together, then (2) confirming the
// token can list correlation rules. Runs in-process on the platform with the
// decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching Exabeam at ${baseUrl}. Check the region and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${baseUrl}. Check the selected Exabeam region.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  return `Could not reach Exabeam (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const built = buildExabeamClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, region } = built
  const baseUrl = `region ${region}`

  const started = Date.now()
  try {
    const res = await client.request('GET', '/correlation-rules/v2/rules')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Exabeam rejected the API Key or denied access (HTTP ${res.status}). Check the Key/Secret and its permission set.`,
        details: [`Target: ${baseUrl}`, 'Auth: API Key (client_credentials)'],
        latencyMs,
      }
    }
    if (res.status === 409) {
      return {
        ok: false,
        message: 'Correlation Rules is not enabled for this Exabeam subscription (HTTP 409).',
        details: [`Target: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      return {
        ok: true,
        message: `Connected to Exabeam (${baseUrl}).`,
        details: [`Target: ${baseUrl}`, 'Auth: API Key (client_credentials)'],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `Exabeam returned HTTP ${res.status}: ${exabeamErrorMessage(res)}`,
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

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildAkamaiClient,
  resolveEdgeGridCredentials,
  NETWORK_LISTS_PATH,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/akamaiApi'

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

// =============================================================================
// Akamai — connection test.
//
// Verifies a Connection's host + EdgeGrid credential with one signed, read-only
// request to the Network Lists API v2
// (GET /network-list/v2/network-lists?listType=IP&includeElements=false). A 2xx
// proves the host resolves AND the EdgeGrid signature authenticates; a 401/403
// proves reachability but flags the credential. Runs in-process on the platform
// with the decrypted credential.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return { ok: false, message: 'No host is configured for this connection. Set the Akamai API host (from your .edgerc).' }
  }
  if (!resolveEdgeGridCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildAkamaiClient(host, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client, baseUrl } = built
  const details = [`Endpoint: ${baseUrl}`, 'Auth: EdgeGrid (EG1-HMAC-SHA256)']

  const started = Date.now()
  try {
    const res = await client.request('GET', NETWORK_LISTS_PATH, { query: { listType: 'IP', includeElements: false } })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Reached Akamai but the EdgeGrid signature was rejected (HTTP ${res.status}). Check the client_token / access_token / client_secret and that the client has Network Lists access.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return { ok: false, message: `Network Lists API not found (404) at ${baseUrl}. Check the API host.`, details, latencyMs }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to the Akamai Network Lists API (${baseUrl}).`, details, latencyMs }
    }
    return { ok: false, message: `Akamai API returned HTTP ${res.status}.`, details, latencyMs }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out reaching the Akamai API at ${baseUrl}.`, details, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${baseUrl}.`, details, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${baseUrl}.`, details, latencyMs }
    return { ok: false, message: `Could not reach the Akamai API (${baseUrl}): ${msg}`, details, latencyMs }
  }
}

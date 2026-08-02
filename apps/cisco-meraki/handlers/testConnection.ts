import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { BASE_URL, buildMerakiClient, listOrganizations, resolveMerakiApiKey, MISSING_CREDENTIAL_MESSAGE } from '../lib/merakiApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves at load time.
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
// Cisco Meraki — connection test.
//
// Verifies a Connection's Dashboard API key by calling GET /organizations at the
// fixed https://api.meraki.com/api/v1 base. A 2xx (even an empty list) confirms
// the key authenticates; a 401 proves reachability but flags the key. The base
// URL is fixed for every organization, so no endpoint/host is required — only
// the API key.
// =============================================================================

function classifyProbeError(message: string): string {
  if (/abort|timed?\s?out/i.test(message)) return 'Timed out reaching the Meraki Dashboard API. Check network reachability.'
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) return 'Could not resolve the Meraki Dashboard API host (api.meraki.com).'
  if (/ECONNREFUSED/i.test(message)) return 'Connection refused by the Meraki Dashboard API.'
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) return `TLS/certificate error reaching the Meraki Dashboard API: ${message}`
  return `Could not reach the Meraki Dashboard API: ${message}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveMerakiApiKey(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildMerakiClient(ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client } = built
  const details = [`Endpoint: ${BASE_URL}`, 'Auth: Dashboard API key (Bearer)']
  const started = Date.now()

  try {
    const orgs = await listOrganizations(client)
    const latencyMs = Date.now() - started
    return {
      ok: true,
      message: `Connected to the Meraki Dashboard API (${orgs.length} organization(s) visible to this key).`,
      details,
      latencyMs,
    }
  } catch (err) {
    const latencyMs = Date.now() - started
    const message = err instanceof Error ? err.message : String(err)
    if (/HTTP 401|HTTP 403/.test(message)) {
      return {
        ok: false,
        message: `Meraki rejected the API key (${message}). Check the key value and that it is still enabled for this admin.`,
        details,
        latencyMs,
      }
    }
    return { ok: false, message: classifyProbeError(message), details, latencyMs }
  }
}

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildSophosClient,
  MISSING_CREDENTIAL_MESSAGE,
  resolveSophosCredentials,
  TOKEN_URL,
  WHOAMI_URL,
} from '../lib/sophosCentral'

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
// Sophos Central — connection test.
//
// Verifies a Connection's OAuth2 service-principal credential by exchanging
// it for a bearer token against the global Sophos ID token endpoint, then
// calling the Who-Am-I API to resolve the tenant id and its data-region API
// host. There is no per-tenant endpoint to configure — both steps happen
// against fixed global hosts, and the data region is discovered, not chosen.
// =============================================================================

function classifyProbeError(message: string): string {
  if (/abort|timed?\s?out/i.test(message)) return 'Timed out reaching the Sophos Central API. Check network reachability.'
  if (/ENOTFOUND|getaddrinfo|dns/i.test(message)) return 'Could not resolve a Sophos Central API host.'
  if (/ECONNREFUSED/i.test(message)) return 'Connection refused by the Sophos Central API.'
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(message)) return `TLS/certificate error reaching the Sophos Central API: ${message}`
  return `Could not reach the Sophos Central API: ${message}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveSophosCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client } = built
  const details = [`Auth: ${TOKEN_URL}`, `Who-Am-I: ${WHOAMI_URL}`]
  const started = Date.now()

  try {
    const tenantId = await client.tenantId()
    const latencyMs = Date.now() - started
    return {
      ok: true,
      message: `Connected to Sophos Central (tenant ${tenantId}).`,
      details,
      latencyMs,
    }
  } catch (err) {
    const latencyMs = Date.now() - started
    const message = err instanceof Error ? err.message : String(err)
    if (/HTTP 401|HTTP 403|authentication failed/i.test(message)) {
      return {
        ok: false,
        message: `Sophos ID rejected the service principal (${message}). Check the Client ID/Client Secret and that the credential set is still enabled.`,
        details,
        latencyMs,
      }
    }
    return { ok: false, message: classifyProbeError(message), details, latencyMs }
  }
}

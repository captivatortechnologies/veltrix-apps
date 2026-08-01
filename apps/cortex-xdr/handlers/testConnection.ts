import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildCortexClient,
  cortexErrorMessage,
  resolveCortexXdrCredentials,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/cortexXdrApi'

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
// Cortex XDR — connection test.
//
// Verifies a Connection with a single authenticated request against the public
// API: POST /public_api/v1/endpoints/get_endpoint_groups/ with an empty
// { request_data: {} }. It proves the tenant API FQDN is reachable and the API
// Key ID / API Key (Standard auth) are valid. Runs in-process with the decrypted
// credential.
// =============================================================================

function classifyProbeError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Cortex XDR at ${baseUrl}. Check the tenant API FQDN and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${baseUrl}. Check the Cortex XDR tenant API FQDN (Settings > Configurations > API Keys > Copy URL).`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}. Check the Cortex XDR tenant API FQDN.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${baseUrl}: ${msg}.`
  return `Could not reach Cortex XDR (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message:
        'No endpoint is configured for this connection. Set the Cortex XDR tenant API FQDN (e.g. ' +
        'api-yourtenant.xdr.us.paloaltonetworks.com) on the connection.',
    }
  }
  if (!resolveCortexXdrCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildCortexClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, baseUrl } = built
  const details = [`Tenant: ${baseUrl}`, 'Auth: x-xdr-auth-id + Authorization (Standard)']
  const started = Date.now()

  try {
    const res = await client.health()
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Cortex XDR rejected the credential (HTTP ${res.status}). Check the API Key ID and API Key, and that the key's security level is Standard.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Cortex XDR (${baseUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Cortex XDR API returned HTTP ${res.status}: ${cortexErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err, baseUrl), details, latencyMs: Date.now() - started }
  }
}

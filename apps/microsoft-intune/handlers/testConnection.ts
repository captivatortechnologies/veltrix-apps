import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, resolveIntuneCredentials, MISSING_CREDENTIAL_MESSAGE } from '../lib/intune'

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
// Microsoft Intune — connection test.
//
// Runs the OAuth2 client-credentials handshake (inside IntuneClient.request) and
// one lightweight authenticated GET /deviceManagement/configurationPolicies?$top=1.
// A failed token exchange surfaces as a synthetic status:0 response. Runs
// in-process with the decrypted app-registration credential.
// =============================================================================

function classifyNetworkError(err: unknown, graphHost: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching ${graphHost}. Check the Azure cloud setting and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${graphHost}. Check the Azure cloud setting.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${graphHost}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${graphHost}: ${msg}`
  return `Could not reach Microsoft Graph (${graphHost}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveIntuneCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildIntuneClient(ctx.endpoint || ctx.component?.hostname || undefined, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, graphHost, cloud } = built
  const details = [`Graph host: ${graphHost}`, `Cloud: ${cloud}`, 'Auth: OAuth2 app registration']
  const started = Date.now()

  try {
    const res = await client.request('GET', '/deviceManagement/configurationPolicies', { query: { $top: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 0) {
      return {
        ok: false,
        message: `Authentication failed: ${graphErrorMessage(res)}. Check the Tenant ID, the credential's Client ID/Secret, and that admin consent was granted.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Graph rejected the token (HTTP ${res.status}). The app registration needs DeviceManagementConfiguration.ReadWrite.All (admin-consented) and the tenant needs an Intune license.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Microsoft Intune via Graph (${graphHost}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Graph returned HTTP ${res.status}: ${graphErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyNetworkError(err, graphHost), details, latencyMs: Date.now() - started }
  }
}

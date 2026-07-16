import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage, resolveMdeCredentials, MISSING_CREDENTIAL_MESSAGE } from '../lib/mde'

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
// Microsoft Defender for Endpoint — connection test.
//
// Runs the OAuth2 client-credentials handshake (inside MdeClient.request) and
// one lightweight authenticated GET /api/indicators?$top=1. A failed token
// exchange surfaces as a synthetic status:0 response carrying the reason. Runs
// in-process with the decrypted app-registration credential.
// =============================================================================

function classifyNetworkError(err: unknown, apiHost: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching the Defender API at ${apiHost}. Check the API host and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${apiHost}. Check the API host / Azure cloud setting.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${apiHost}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${apiHost}: ${msg}`
  return `Could not reach the Defender API (${apiHost}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveMdeCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildMdeClient(ctx.endpoint || ctx.component?.hostname || undefined, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, apiHost, cloud } = built
  const details = [`API host: ${apiHost}`, `Cloud: ${cloud}`, 'Auth: OAuth2 app registration']
  const started = Date.now()

  try {
    const res = await client.request('GET', '/indicators', { query: { $top: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 0) {
      // The token handshake failed — MdeClient returns a synthetic status:0.
      return {
        ok: false,
        message: `Authentication failed: ${mdeErrorMessage(res)}. Check the Tenant ID, the credential's Client ID/Secret, and that admin consent was granted.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Defender rejected the token (HTTP ${res.status}). The app registration needs the WindowsDefenderATP application permission Ti.ReadWrite.All with admin consent.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Microsoft Defender for Endpoint (${apiHost}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Defender API returned HTTP ${res.status}: ${mdeErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyNetworkError(err, apiHost), details, latencyMs: Date.now() - started }
  }
}

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  resolveCloudflareToken,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/cloudflare'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves at load time —
// older SDKs predate these type exports. Only long-standing types are imported.
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
// Cloudflare — connection test.
//
// Verifies a Connection by calling GET /user/tokens/verify — the canonical
// token-scoped health endpoint. It proves the API token is valid and active
// without needing a zone or account. Runs in-process with the decrypted token.
// =============================================================================

function classifyProbeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching the Cloudflare API. Check network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve the Cloudflare API host.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by the Cloudflare API.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching the Cloudflare API: ${msg}`
  return `Could not reach the Cloudflare API: ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No endpoint is configured for this connection. Set the Cloudflare zone (apex) domain on the connection.',
    }
  }
  if (!resolveCloudflareToken(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildCloudflareClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, domain } = built
  const details = [`Zone: ${domain}`, 'Auth: API token']
  const started = Date.now()

  try {
    const res = await client.verifyToken()
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Cloudflare rejected the API token (HTTP ${res.status}). Check the token value and that it carries the required permissions.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: 'Connected to Cloudflare (API token verified).', details, latencyMs }
    }
    return {
      ok: false,
      message: `Cloudflare API returned HTTP ${res.status}: ${cloudflareErrorMessage(res)}`,
      details,
      latencyMs,
    }
  } catch (err) {
    return { ok: false, message: classifyProbeError(err), details, latencyMs: Date.now() - started }
  }
}

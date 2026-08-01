import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildSecretServerClient,
  secretServerErrorMessage,
  resolveSecretServerCredentials,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/secretServerApi'

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
// Delinea Secret Server — connection test.
//
// Runs the OAuth2 password grant (POST <base>/oauth2/token) then a lightweight
// authorized probe (GET /api/v1/folders?take=1) against the REST API. Proves the
// Secret Server base URL is reachable and the API user's credential is valid.
// HTTPS, self-signed tolerated (toggle with the verify_tls setting).
// =============================================================================

function classifyError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Secret Server at ${baseUrl}. Check the base URL and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve the host in ${baseUrl}.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}. Check the base URL and that Secret Server is listening.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) {
    return `TLS/certificate error reaching ${baseUrl}: ${msg}. Turn off "Verify TLS certificate" for a self-signed on-prem instance.`
  }
  return `Could not reach Secret Server (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const rawEndpoint = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!rawEndpoint) {
    return {
      ok: false,
      message: 'No endpoint is configured. Set the Secret Server base URL (on-prem https://<host>/SecretServer, cloud https://<tenant>.secretservercloud.com).',
    }
  }
  if (!resolveSecretServerCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildSecretServerClient(rawEndpoint, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client, apiBase, baseUrl } = built
  const details = [`Base URL: ${baseUrl}`, 'Auth: OAuth2 password grant']
  const started = Date.now()

  try {
    // Step 1 — OAuth2 password grant (validates the credential).
    const session = await client.ensureToken()
    if (!session.ok) {
      return {
        ok: false,
        message: `Secret Server rejected the logon: ${session.error}. Check the API user's username/password and that Webservices is enabled.`,
        details,
        latencyMs: Date.now() - started,
      }
    }

    // Step 2 — lightweight authorized probe.
    const res = await client.request('GET', '/folders', { query: { take: 1 } })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Secret Server authorized the logon but rejected the probe (HTTP ${res.status}). The API user may lack permission to view folders.`,
        details,
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Secret Server REST API not found (404) at ${apiBase}. Check the base URL — on-prem needs the "/SecretServer" path.`,
        details,
        latencyMs,
      }
    }
    if (res.ok) {
      return { ok: true, message: `Connected to Secret Server (${apiBase}).`, details, latencyMs }
    }
    return { ok: false, message: `Secret Server returned HTTP ${res.status}: ${secretServerErrorMessage(res)}`, details, latencyMs }
  } catch (err) {
    return { ok: false, message: classifyError(err, baseUrl), details, latencyMs: Date.now() - started }
  }
}

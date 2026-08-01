import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  normalizeBaseUrl,
  createSession,
  resolveTimeoutMs,
  looksLikeLoginPage,
  CybereasonAuthError,
  CLASSIFICATION_DOWNLOAD_PATH,
} from '../lib/cybereasonApi'

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
// Cybereason — connection test.
//
// Verifies a Connection by running the session-cookie login (POST /login.html
// with the credential's username/password) and then a single bounded
// authenticated read (GET /rest/classification/download). The login proves the
// username/password; the read proves the JSESSIONID carries API access and the
// tenant endpoint is reachable. Runs in-process with the decrypted credential.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) {
    return { ok: false, message: 'No endpoint is configured for this connection. Set the Cybereason tenant URL (e.g. acme.cybereason.net).' }
  }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  if (!(ctx.credential.username || '').trim() || !(ctx.credential.password || '')) {
    return { ok: false, message: 'Cybereason authenticates with a username and password — attach both to this connection.' }
  }

  const base = normalizeBaseUrl(raw)
  const details = [`Endpoint: ${base}`, 'Auth: session cookie (username / password)']
  const timeoutMs = resolveTimeoutMs(ctx.settings, 10_000)
  const started = Date.now()

  try {
    const session = await createSession(base, ctx.credential, timeoutMs)
    const res = await session.get(CLASSIFICATION_DOWNLOAD_PATH)
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403 || looksLikeLoginPage(res.body)) {
      return {
        ok: false,
        message: `Reached Cybereason but the session was not authorized (HTTP ${res.status}). Check the account's API permissions.`,
        details,
        latencyMs,
      }
    }
    if (!res.ok) {
      return { ok: false, message: `Cybereason returned HTTP ${res.status}.`, details, latencyMs }
    }
    return { ok: true, message: `Connected to Cybereason (${base}).`, details, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    if (err instanceof CybereasonAuthError) {
      return { ok: false, message: err.message, details, latencyMs }
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${timeoutMs / 1000}s connecting to ${base}.`, details, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, details, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the tenant URL.`, details, latencyMs }
    if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b|DEPTH_ZERO|UNABLE_TO_VERIFY/i.test(msg)) {
      return { ok: false, message: `TLS/certificate error reaching ${base}: ${msg}`, details, latencyMs }
    }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, details, latencyMs }
  }
}

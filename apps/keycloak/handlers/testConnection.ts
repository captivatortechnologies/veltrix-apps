import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  normalizeBaseUrl,
  fetchAdminToken,
  keycloakRequest,
  resolveGrant,
  resolveRealm,
  resolveAuthRealm,
  resolveVerifyTls,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/keycloakApi'

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

const TIMEOUT_MS = 10_000

/** Normalize a raw endpoint/host into an https base URL with no trailing slash. */
function resolveBaseUrl(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!raw) return null
  return normalizeBaseUrl(raw)
}

// =============================================================================
// Keycloak — connection test.
//
// Verifies a Connection's endpoint + admin credential by (1) obtaining an admin
// token from POST /realms/{authRealm}/protocol/openid-connect/token, then (2)
// calling GET /admin/realms/{realm}. A 2xx on the realm read confirms the endpoint
// resolves, the token was issued, AND it authorizes admin access; an auth failure
// on the token step flags the credential. HTTPS, self-signed tolerated unless the
// verify_tls setting is on.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const base = resolveBaseUrl(ctx)
  if (!base) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!resolveGrant(ctx.credential)) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const realm = resolveRealm(ctx.settings)
  const authRealm = resolveAuthRealm(ctx.settings)
  const verifyTls = resolveVerifyTls(ctx.settings)
  const started = Date.now()

  try {
    const token = await fetchAdminToken(base, authRealm, ctx.credential, { timeoutMs: TIMEOUT_MS, verifyTls })
    if (token.error || !token.token) {
      const latencyMs = Date.now() - started
      const status = token.status
      if (status === 401 || status === 403) {
        return {
          ok: false,
          message: `Reached Keycloak but authentication failed (HTTP ${status}). Check the client-id/secret (or admin user/password).`,
          details: [`Endpoint: ${base}`, `Token realm: ${authRealm}`],
          latencyMs,
        }
      }
      return { ok: false, message: token.error ?? 'Could not obtain an admin token.', details: [`Endpoint: ${base}`], latencyMs }
    }

    const res = await keycloakRequest(`${base}/admin/realms/${encodeURIComponent(realm)}`, {
      headers: { Authorization: `Bearer ${token.token}` },
      timeoutMs: TIMEOUT_MS,
      verifyTls,
    })
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Token issued but it lacks admin access to realm "${realm}" (HTTP ${res.status}). Grant the realm-management "manage-clients"/"view-realm" role.`,
        details: [`Endpoint: ${base}`, `Managed realm: ${realm}`],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Managed realm "${realm}" was not found (HTTP 404). Check the "Managed realm" setting.`,
        details: [`Endpoint: ${base}`, `Managed realm: ${realm}`],
        latencyMs,
      }
    }
    if (!res.ok) {
      return { ok: false, message: `Keycloak returned HTTP ${res.status}.`, details: [`Endpoint: ${base}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Keycloak realm "${realm}" (HTTP ${res.status}).`,
      details: [`Endpoint: ${base}`, `Managed realm: ${realm}`, `Token realm: ${authRealm}`],
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${base}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${base}.`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${base}. Check the port and that Keycloak is listening.`, latencyMs }
    return { ok: false, message: `Could not reach ${base}: ${msg}`, latencyMs }
  }
}

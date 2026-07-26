import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/netskope'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever @veltrixsecops/app-sdk
// version the platform resolves at load time. Only long-standing types
// (CredentialRef) are imported.
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
// Netskope — connection test.
//
// Calls GET /api/v2/policy/urllist. A success confirms the tenant, token AND the
// token's endpoint privilege; a 401/403 pinpoints a bad/expired token or a token
// that wasn't granted the url-list endpoints.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildNetskopeClient(cred, settings)
  const details = [`Tenant API: ${cred.baseUrl}`, 'Auth: Netskope-Api-Token header']
  const started = Date.now()
  const res = await client.get('/policy/urllist?limit=1&offset=0')
  const latencyMs = Date.now() - started

  if (res.transportError) {
    return { ok: false, message: `Could not reach Netskope: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    return { ok: true, message: 'Connected to the Netskope REST API v2.', details, latencyMs }
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message:
        `Netskope rejected the token (HTTP ${res.status}). Check the token value, and that it was granted the ` +
        `/api/v2/policy/urllist and /api/v2/policy/urllist/deploy endpoints with Read + Write privilege.`,
      details,
      latencyMs,
    }
  }
  return { ok: false, message: `Netskope returned HTTP ${res.status}: ${netskopeErrorMessage(res)}`, details, latencyMs }
}

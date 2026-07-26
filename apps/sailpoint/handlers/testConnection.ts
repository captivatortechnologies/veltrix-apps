import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/isc'

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
// SailPoint Identity Security Cloud — connection test.
//
// ISC is a cloud API, so there is no per-server host to reach. This verifies the
// OAuth2 client-credentials token exchange against the tenant, then a lightweight
// GET /transforms/v1. A 2xx confirms the tenant, client id, secret AND scope are
// all in place; a token failure or 401/403 pinpoints which part is wrong.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildIscClient(cred, settings)
  const details = [`Tenant API: ${cred.baseUrl}`, `Client ID: ${cred.clientId}`, 'Auth: OAuth2 client credentials']
  const started = Date.now()
  const res = await client.get('/transforms/v1?limit=1')
  const latencyMs = Date.now() - started

  // status 0 means the token exchange or the network request itself failed —
  // the body carries the underlying reason.
  if (res.status === 0) {
    return { ok: false, message: `Could not reach SailPoint ISC: ${res.body}`, details, latencyMs }
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message:
        `SailPoint ISC rejected the credential (HTTP ${res.status}). Check the client secret and that the ` +
        `client / PAT has the required scopes (generate the PAT from an ORG_ADMIN user).`,
      details,
      latencyMs,
    }
  }
  if (res.ok) {
    return {
      ok: true,
      message: 'Connected to SailPoint Identity Security Cloud.',
      details,
      latencyMs,
    }
  }
  return { ok: false, message: `SailPoint ISC returned HTTP ${res.status}: ${iscErrorMessage(res)}`, details, latencyMs }
}

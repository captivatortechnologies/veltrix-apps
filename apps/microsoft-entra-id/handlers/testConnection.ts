import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/graph'

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
// Microsoft Entra ID — connection test.
//
// Entra is a cloud API, so there is no per-server host to reach. This verifies
// the app-registration credential end to end: the OAuth2 client-credentials
// token exchange against the tenant, then `GET /organization` on Microsoft
// Graph. A 2xx confirms the tenant ID, client ID, secret AND admin consent are
// all in place; a token failure or 401/403 pinpoints which part is wrong.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildGraphClient(cred, settings)
  const details = [`Tenant: ${cred.tenantId}`, `Client ID: ${cred.clientId}`, 'Auth: OAuth2 client credentials']
  const started = Date.now()
  const res = await client.get('/organization?$select=id,displayName')
  const latencyMs = Date.now() - started

  // status 0 means the token exchange or the network request itself failed —
  // the body carries the underlying reason.
  if (res.status === 0) {
    return { ok: false, message: `Could not reach Microsoft Entra: ${res.body}`, details, latencyMs }
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message:
        `Microsoft Graph rejected the app registration (HTTP ${res.status}). Check the client secret and that ` +
        `admin consent was granted for the required application permissions.`,
      details,
      latencyMs,
    }
  }
  if (res.ok) {
    const org = parseJson<{ value?: Array<{ displayName?: string }> }>(res.body)
    const name = org?.value?.[0]?.displayName
    return {
      ok: true,
      message: `Connected to Microsoft Entra${name ? ` tenant "${name}"` : ''}.`,
      details: [...details, ...(name ? [`Tenant name: ${name}`] : [])],
      latencyMs,
    }
  }
  return { ok: false, message: `Microsoft Graph returned HTTP ${res.status}: ${graphErrorMessage(res)}`, details, latencyMs }
}

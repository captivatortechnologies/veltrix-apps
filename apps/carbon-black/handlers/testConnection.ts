import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/carbonblack'

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
// VMware Carbon Black Cloud — connection test.
//
// Runs a minimal reputation-override _search. A success confirms the base URL,
// org key, API id/secret AND the X-Auth-Token order; a 401/403 pinpoints a bad
// key or missing org.reputations permission.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildCbClient(cred, settings)
  const details = [`Base URL: ${cred.baseUrl}`, `Org key: ${cred.orgKey}`, `API ID: ${cred.apiId}`, 'Auth: X-Auth-Token (secret/id)']
  const started = Date.now()
  const res = await client.post(`${client.overridesPath()}/_search`, { criteria: {}, start: 0, rows: 1 })
  const latencyMs = Date.now() - started

  if (res.transportError) {
    return { ok: false, message: `Could not reach Carbon Black Cloud: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    return { ok: true, message: 'Connected to VMware Carbon Black Cloud.', details, latencyMs }
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message:
        `Carbon Black rejected the request (HTTP ${res.status}). Check the API ID/Secret, the X-Auth-Token order ` +
        `(secret/id), the Org Key, and that the key has the org.reputations permission.`,
      details,
      latencyMs,
    }
  }
  return { ok: false, message: `Carbon Black returned HTTP ${res.status}: ${cbErrorMessage(res)}`, details, latencyMs }
}

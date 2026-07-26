import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/duo'

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
// Cisco Duo — connection test.
//
// Calls GET /admin/v1/check — Duo's integration ping. A success confirms the API
// host, integration key, secret key AND the request signing are all correct; a
// 40xxx / 401 pinpoints a bad key or signature.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildDuoClient(cred, settings)
  const details = [`API host: ${cred.host}`, `Integration key: ${cred.ikey}`, 'Auth: HMAC-SHA1 signed request']
  const started = Date.now()
  const res = await client.get('/admin/v1/check')
  const latencyMs = Date.now() - started

  if (res.transportError) {
    return { ok: false, message: `Could not reach Cisco Duo: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    return { ok: true, message: 'Connected to the Cisco Duo Admin API.', details, latencyMs }
  }
  if (res.httpStatus === 401 || res.code === 40103) {
    return {
      ok: false,
      message: `Duo rejected the request signature (${duoErrorMessage(res)}). Check the integration key, secret key and API host.`,
      details,
      latencyMs,
    }
  }
  return { ok: false, message: `Cisco Duo returned an error: ${duoErrorMessage(res)}`, details, latencyMs }
}

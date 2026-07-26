import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  addressUrl,
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/fortimanager'

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
// FortiManager — connection test.
//
// Verifies the JSON-RPC session login against the configured host, then a get on
// the ADOM firewall-address table. A success confirms the host, credential AND
// ADOM access; a login/permission failure pinpoints which part is wrong.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildFmgClient(cred, settings)
  const details = [`Host: ${cred.baseUrl}`, `ADOM: ${settings.adom}`, `User: ${cred.user}`, 'Auth: JSON-RPC session login']
  const started = Date.now()
  const res = await client.get(addressUrl(settings.adom))
  const latencyMs = Date.now() - started
  await client.logout()

  if (res.transportError) {
    return { ok: false, message: `Could not reach FortiManager: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    return { ok: true, message: `Connected to FortiManager (ADOM "${settings.adom}").`, details, latencyMs }
  }
  return {
    ok: false,
    message:
      `FortiManager rejected the request: ${fmgErrorMessage(res)}. Check the username/password, that the ` +
      `user has access to ADOM "${settings.adom}", and that the host certificate is trusted.`,
    details,
    latencyMs,
  }
}

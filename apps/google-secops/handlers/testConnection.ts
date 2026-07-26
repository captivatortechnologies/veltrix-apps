import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/googlesecops'

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
// Google Security Operations — connection test.
//
// Mints a token from the service-account key (JWT-bearer) and lists reference
// lists. A success confirms the key, region, project and instance; a token
// failure or 403 pinpoints a bad key or missing role.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildSecOpsClient(cred, settings)
  const details = [`Region: ${settings.region}`, `Project: ${settings.projectId}`, `Instance: ${settings.instanceId}`, 'Auth: service-account (JWT-bearer)']
  const started = Date.now()
  const res = await client.request('GET', `${client.parent()}/referenceLists?pageSize=1&view=REFERENCE_LIST_VIEW_BASIC`)
  const latencyMs = Date.now() - started

  if (res.transportError) {
    return { ok: false, message: `Could not reach Google SecOps: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    return { ok: true, message: 'Connected to the Google Security Operations API.', details, latencyMs }
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message: `Google SecOps rejected the request (HTTP ${res.status}). Check the service-account key and that it has the Chronicle API role.`,
      details,
      latencyMs,
    }
  }
  return { ok: false, message: `Google SecOps returned HTTP ${res.status}: ${secopsErrorMessage(res)}`, details, latencyMs }
}

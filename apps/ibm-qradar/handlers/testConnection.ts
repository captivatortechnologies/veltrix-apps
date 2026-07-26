import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/qradar'

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
// IBM QRadar — connection test.
//
// Lists the reference-data sets. A success confirms the console host, SEC token,
// Version header AND the service role; a 401/403 pinpoints a bad token or
// insufficient permission.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildQRadarClient(cred, settings)
  const details = [`Console: ${cred.baseUrl}`, `API version: ${cred.version}`, 'Auth: SEC authorized-service token']
  const started = Date.now()
  const res = await client.request('GET', '/reference_data/sets', { range: 'items=0-0' })
  const latencyMs = Date.now() - started

  if (res.transportError) {
    return { ok: false, message: `Could not reach IBM QRadar: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    return { ok: true, message: 'Connected to the IBM QRadar REST API.', details, latencyMs }
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message: `QRadar rejected the request (HTTP ${res.status}). Check the SEC token and that its service role has reference-data permission.`,
      details,
      latencyMs,
    }
  }
  return { ok: false, message: `IBM QRadar returned HTTP ${res.status}: ${qradarErrorMessage(res)}`, details, latencyMs }
}

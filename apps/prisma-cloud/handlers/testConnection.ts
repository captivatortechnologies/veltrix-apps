import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/prismacloud'

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
// Prisma Cloud — connection test.
//
// Logs in with the access key and calls GET /compliance. A success confirms the
// API URL, access key id + secret; a 401 pinpoints bad credentials or an
// unreachable/incorrect API URL.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildPcClient(cred, settings)
  const details = [`API URL: ${cred.baseUrl}`, `Access key: ${cred.accessKeyId}`, 'Auth: access-key login (JWT)']
  const started = Date.now()
  const res = await client.get('/compliance')
  const latencyMs = Date.now() - started

  if (res.transportError) {
    return { ok: false, message: `Could not reach Prisma Cloud: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    return { ok: true, message: 'Connected to the Prisma Cloud CSPM API.', details, latencyMs }
  }
  if (res.status === 401) {
    return {
      ok: false,
      message: `Prisma Cloud rejected the login (${pcErrorMessage(res)}). Check the Access Key ID, Secret Key and API URL.`,
      details,
      latencyMs,
    }
  }
  return { ok: false, message: `Prisma Cloud returned an error: ${pcErrorMessage(res)}`, details, latencyMs }
}

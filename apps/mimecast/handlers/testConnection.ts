import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/mimecast'

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
// Mimecast — connection test.
//
// Acquires an OAuth2 token and lists managed URLs. A success confirms the client
// id/secret AND the application's role; a token failure or a fail response
// pinpoints bad credentials or a missing permission.
// =============================================================================

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildMimecastClient(cred, settings)
  const details = [`Base URL: ${cred.baseUrl}`, `Client ID: ${cred.clientId}`, 'Auth: OAuth2 client credentials']
  const started = Date.now()
  const res = await client.request('/api/ttp/url/get-all-managed-urls', {})
  const latencyMs = Date.now() - started

  if (res.transportError) {
    return { ok: false, message: `Could not reach Mimecast: ${res.transportError}`, details, latencyMs }
  }
  if (res.ok) {
    return { ok: true, message: 'Connected to the Mimecast API.', details, latencyMs }
  }
  return {
    ok: false,
    message:
      `Mimecast returned an error: ${mimecastErrorMessage(res)}. Check the Client ID/Secret and that the API ` +
      `application's role grants URL Protection access.`,
    details,
    latencyMs,
  }
}

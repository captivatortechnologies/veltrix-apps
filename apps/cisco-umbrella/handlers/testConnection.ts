import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildUmbrellaClient,
  umbrellaErrorMessage,
  UMBRELLA_BASE_URL,
} from '../lib/umbrellaApi'

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
// Cisco Umbrella — connection test.
//
// Mints an OAuth2 client-credentials token (POST /auth/v2/token) and reads the
// destination lists collection (GET /policies/v2/destinationlists?limit=1). A
// success confirms the API key + secret authenticate and the key has the
// Destination Lists scope; a 401/403 pinpoints a bad key/secret or missing scope.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }

  const details = [`Base URL: ${UMBRELLA_BASE_URL}`, 'Auth: OAuth2 client-credentials (API key + secret)']
  const started = Date.now()
  try {
    const res = await built.client.get('/policies/v2/destinationlists', { page: 1, limit: 1 })
    const latencyMs = Date.now() - started
    if (res.ok) {
      return { ok: true, message: 'Connected to the Cisco Umbrella API.', details, latencyMs }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Umbrella rejected the request (HTTP ${res.status}). Check the API key, secret and that the key has the Destination Lists scope.`,
        details,
        latencyMs,
      }
    }
    return { ok: false, message: `Cisco Umbrella returned an error: ${umbrellaErrorMessage(res)}`, details, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Could not reach Cisco Umbrella: ${msg}`, details, latencyMs }
  }
}

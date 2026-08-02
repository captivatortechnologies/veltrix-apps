import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  resolveImpervaCredentials,
  ACCOUNT_PATH,
  isApiSuccess,
  apiMessage,
  parseJson,
  MISSING_CREDENTIAL_MESSAGE,
  type ImpervaEnvelope,
} from '../lib/impervaApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever SDK the platform resolves.
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
// Imperva — connection test.
//
// Verifies a Connection's API ID + API key with one authenticated, read-only
// request to the Cloud WAF (Incapsula) API v1 (POST /account). The v1 API returns
// HTTP 200 with a `res` envelope, so success is `res === 0`; a non-zero `res`
// (typically a credential error) means the endpoint was reached but the API ID /
// API key were rejected. Runs in-process on the platform with the decrypted
// credential.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  if (!resolveImpervaCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildImpervaClient(ctx.endpoint || ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client, baseUrl } = built
  const details = [`Endpoint: ${baseUrl}`, 'Auth: API ID + API key']

  const started = Date.now()
  try {
    const res = await client.post(ACCOUNT_PATH)
    const latencyMs = Date.now() - started
    const json = parseJson<ImpervaEnvelope>(res.body)

    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `Reached Imperva but authentication failed (HTTP ${res.status}). Check the API ID / API key.`, details, latencyMs }
    }
    if (res.status <= 0 || res.status >= 500) {
      return { ok: false, message: `Imperva API returned HTTP ${res.status}.`, details, latencyMs }
    }
    if (isApiSuccess(json)) {
      return { ok: true, message: `Connected to the Imperva Cloud WAF API (${baseUrl}).`, details, latencyMs }
    }
    return {
      ok: false,
      message: `Reached Imperva but the API rejected the request: ${apiMessage(json)}. Check the API ID / API key and that the API key is enabled.`,
      details,
      latencyMs,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const latencyMs = Date.now() - started
    if (/abort|timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out reaching the Imperva API at ${baseUrl}.`, details, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host in ${baseUrl}.`, details, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${baseUrl}.`, details, latencyMs }
    return { ok: false, message: `Could not reach the Imperva API (${baseUrl}): ${msg}`, details, latencyMs }
  }
}

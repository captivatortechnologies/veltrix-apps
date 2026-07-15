import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildVaultClient, resolveVaultToken, parseJson, vaultErrorMessage } from '../lib/vault'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves when it loads the
// handler — older SDKs predate these type exports. Only long-standing types
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
// HashiCorp Vault — connection test.
//
// Verifies a Connection by calling the Vault HTTP API with the credential's
// token: `GET /v1/auth/token/lookup-self`. This is the lightest authenticated
// call Vault offers — a 2xx confirms the endpoint resolves AND the token is
// valid and unexpired; 401/403 = bad/expired token, 404 = the address is not a
// Vault API. Runs in-process on the platform with the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching Vault at ${baseUrl}. Check the address and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${baseUrl}. Check the Vault address.`
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `Connection refused by ${baseUrl}. Check the Vault address and port.`
  }
  if (/self.signed|certificate|CERT_|ERR_TLS|DEPTH_ZERO|unable to verify|SSL/i.test(msg)) {
    return `TLS error reaching ${baseUrl}: ${msg}. Check the Vault certificate.`
  }
  return `Could not reach Vault (${baseUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) return { ok: false, message: 'No Vault address / endpoint is configured for this connection.' }

  const token = resolveVaultToken(ctx.credential)
  if (!token) {
    return { ok: false, message: 'No Vault token found. Store the Vault token in the connection’s API token field.' }
  }

  const built = buildVaultClient(host, ctx.credential, ctx.settings)
  if ('error' in built) return { ok: false, message: built.error }
  const { client, baseUrl } = built
  const started = Date.now()

  try {
    const res = await client.request('GET', '/auth/token/lookup-self')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Vault rejected the token (HTTP ${res.status}). Check the token and that it has not expired.`,
        details: [`Vault: ${baseUrl}`, 'Auth: X-Vault-Token'],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Vault API not found at ${baseUrl} (404). Check that the address points at a Vault server.`,
        details: [`Vault: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      const displayName = parseJson<{ data?: { display_name?: string } }>(res.body)?.data?.display_name
      return {
        ok: true,
        message: `Connected to Vault at ${baseUrl}.`,
        details: [`Vault: ${baseUrl}`, `Auth: token${displayName ? ` (${displayName})` : ''}`],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `Vault returned HTTP ${res.status}.`,
      details: [`Vault: ${baseUrl}`, ...(res.body ? [`Response: ${vaultErrorMessage(res).slice(0, 200)}`] : [])],
      latencyMs,
    }
  } catch (err) {
    return {
      ok: false,
      message: classifyNetworkError(err, baseUrl),
      details: [`Vault: ${baseUrl}`],
      latencyMs: Date.now() - started,
    }
  }
}

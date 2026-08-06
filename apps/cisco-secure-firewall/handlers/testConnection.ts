import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildFmcClient, fmcErrorMessage } from '../lib/fmc'
import { ACCESS_POLICIES_PATH } from '../config-types/access-control-policies/validate'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester).
// Declared here rather than imported from the SDK so the handler compiles against
// whatever @veltrixsecops/app-sdk version the platform resolves when it loads the
// handler - older SDKs predate these type exports. Only long-standing types
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
// Cisco Secure Firewall (FMC) - connection test.
//
// Generates a session token (POST /api/fmc_platform/v1/auth/generatetoken,
// the same login FMC's own web UI uses) then confirms the resulting session
// can list Access Control Policies - a lightweight, always-available call
// that proves the credentials, host and domain scoping are all correct
// together. Runs in-process on the platform with the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, fmcUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) {
    return `Timed out reaching FMC at ${fmcUrl}. Check the management address and network reachability.`
  }
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) {
    return `Could not resolve ${fmcUrl}. Check the FMC management address.`
  }
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${fmcUrl}.`
  return `Could not reach FMC (${fmcUrl}): ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const hostname = ctx.endpoint || ctx.component?.hostname || ''
  const built = buildFmcClient(hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, fmcUrl } = built

  const started = Date.now()
  try {
    const listed = await client.list(ACCESS_POLICIES_PATH)
    const latencyMs = Date.now() - started

    if (!listed.ok) {
      if (listed.status === 401 || listed.status === 403) {
        return {
          ok: false,
          message: `FMC rejected the login or denied access (HTTP ${listed.status}). Check the username and password.`,
          details: [`Target: ${fmcUrl}`, 'Auth: local/RBAC user (username/password)'],
          latencyMs,
        }
      }
      return {
        ok: false,
        message: `FMC returned HTTP ${listed.status} listing Access Control Policies: ${fmcErrorMessage({
          status: listed.status,
          ok: false,
          body: listed.body,
        })}`,
        details: [`Target: ${fmcUrl}`],
        latencyMs,
      }
    }

    return {
      ok: true,
      message: `Connected to FMC (${listed.items.length} Access Control Policy/Policies visible).`,
      details: [`Target: ${fmcUrl}`, 'Auth: local/RBAC user (username/password)'],
      latencyMs,
    }
  } catch (error) {
    return {
      ok: false,
      message: classifyNetworkError(error, fmcUrl),
      details: [`Target: ${fmcUrl}`],
      latencyMs: Date.now() - started,
    }
  }
}

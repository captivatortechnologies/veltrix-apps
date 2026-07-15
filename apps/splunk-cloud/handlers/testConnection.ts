import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { readAcsSettings, resolveStackName, resolveAcsToken, acsRequest } from '../lib/acs'

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
// Splunk Cloud — connection test.
//
// Verifies a Connection by calling the Admin Config Service (ACS) with the
// stack's JWT: `GET /{stack}/adminconfig/v2/indexes`. A 2xx confirms the stack
// resolves AND the token authenticates; 401/403 = bad token, 404 = wrong stack.
// Runs in-process on the platform with the decrypted credential.
// =============================================================================

function classifyNetworkError(err: unknown, baseUrl: string, stack: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching ACS for stack "${stack}". Check the stack name and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${baseUrl}. Check the ACS base URL.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${baseUrl}.`
  return `Could not reach ACS (${baseUrl}) for stack "${stack}": ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) return { ok: false, message: 'No stack / endpoint is configured for this connection.' }

  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return { ok: false, message: 'No ACS token found. Store the stack JWT in the connection’s API token field.' }
  }

  const stack = resolveStackName(host)
  const { baseUrl, timeoutMs } = readAcsSettings(ctx.settings)
  const started = Date.now()

  try {
    const res = await acsRequest({ baseUrl, stack, token, timeoutMs }, 'GET', '/indexes')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `ACS rejected the token (HTTP ${res.status}). Check the stack JWT and its scope.`,
        details: [`Stack: ${stack}`, `ACS: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Stack "${stack}" was not found (404). Check the stack name.`,
        details: [`ACS: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.ok) {
      return {
        ok: true,
        message: `Connected to Splunk Cloud stack "${stack}".`,
        details: [`Stack: ${stack}`, `ACS: ${baseUrl}`, 'Auth: stack JWT'],
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `ACS returned HTTP ${res.status}.`,
      details: [`Stack: ${stack}`, ...(res.body ? [`Response: ${res.body.slice(0, 200)}`] : [])],
      latencyMs,
    }
  } catch (err) {
    return {
      ok: false,
      message: classifyNetworkError(err, baseUrl, stack),
      details: [`Stack: ${stack}`, `ACS: ${baseUrl}`],
      latencyMs: Date.now() - started,
    }
  }
}

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { readAcsSettings, resolveStackName, looksLikeJwt, acsRequest, acsErrorMessage } from '../lib/acs'

// The auth-method label shown in this app's Connections form (see
// client/pages/ConnectionsPage.tsx `tokenLabel`). Referenced in guidance so the
// message points the user at the exact dropdown option to pick.
const TOKEN_AUTH_LABEL = 'API / HEC token'

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
// Splunk Cloud administration (the Admin Config Service on admin.splunk.com AND
// the stack REST API on :8089) authenticates ONLY with a Splunk JWT bearer
// token — never a username/password. So the test first works out whether the
// connection actually carries a JWT:
//   • API-token field populated → use it.
//   • JWT pasted into the password field (looks like `eyJ…`) → use it.
//   • otherwise it's a username/password → ACS can't use it; tell the user how
//     to create a token instead of firing a request doomed to 401.
// With a JWT it calls `GET /{stack}/adminconfig/v2/indexes`: 2xx confirms the
// stack resolves AND the token authenticates; 401/403 = bad token, 404 = wrong
// stack. Runs in-process on the platform with the decrypted credential.
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

  const stack = resolveStackName(host)
  const { baseUrl, timeoutMs } = readAcsSettings(ctx.settings)

  const apiToken = ctx.credential?.apiToken?.trim() || ''
  const username = ctx.credential?.username?.trim() || ''
  const password = ctx.credential?.password?.trim() || ''

  // A JWT from the API-token field (preferred) or pasted into the password field.
  const jwt = apiToken || (looksLikeJwt(password) ? password : '')

  if (!jwt) {
    if (username || password) {
      return {
        ok: false,
        message:
          'This connection uses a username/password, but Splunk Cloud authenticates with a stack JWT bearer token — not a password.',
        details: [
          `Stack: ${stack}`,
          `Create a token in Splunk Web → Settings → Tokens (as an sc_admin user), then edit this connection: set Auth method to “${TOKEN_AUTH_LABEL}” and paste the JWT.`,
        ],
      }
    }
    return {
      ok: false,
      message: `No credential is set. Add a stack JWT (Auth method: “${TOKEN_AUTH_LABEL}”) to test connectivity.`,
      details: [`Stack: ${stack}`],
    }
  }

  const started = Date.now()

  try {
    const res = await acsRequest({ baseUrl, stack, token: jwt, timeoutMs }, 'GET', '/indexes')
    const latencyMs = Date.now() - started

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `ACS rejected the token (HTTP ${res.status}). The stack JWT is invalid, expired, or lacks the sc_admin role.`,
        // Surface ACS's own {code, message} so the real reason (e.g. token
        // expired / wrong audience / stack not entitled) reaches the user.
        details: [`Stack: ${stack}`, `ACS: ${baseUrl}`, `ACS says: ${acsErrorMessage(res)}`],
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
    if (res.status === 429) {
      return {
        ok: false,
        message: 'ACS rate limit hit (HTTP 429, 600 requests / 10 min). Retry shortly.',
        details: [`Stack: ${stack}`, `ACS: ${baseUrl}`],
        latencyMs,
      }
    }
    if (res.status >= 500) {
      // A 5xx is a Splunk ACS / stack-side error, NOT an auth rejection (that
      // would be 401/403) — so the endpoint resolved and the token was accepted.
      // ACS itself flags these as possibly transient; the stack may also not be
      // fully ACS-entitled (common on trials).
      return {
        ok: false,
        message: `ACS/stack returned HTTP ${res.status} — a Splunk-side error, not a credential rejection (the token was accepted). Often transient; retry shortly, or check the stack is ACS-entitled.`,
        details: [`Stack: ${stack}`, `ACS: ${baseUrl}`, `ACS says: ${acsErrorMessage(res)}`],
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
      message: `ACS returned HTTP ${res.status}. ${acsErrorMessage(res)}`,
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

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  readZscalerSettings,
  resolveHosts,
  resolveZscalerCredentials,
  zscalerErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/zscaler'

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
// Zscaler — connection test.
//
// Verifies a Connection with a real server-side auth probe against the Zscaler
// OneAPI (Zidentity). The credential's OAuth2 client-credentials pair — Client
// ID in `credential.username`, Client Secret in `credential.apiToken` — is
// exchanged for a bearer token at `https://<vanity>.zslogin.net/oauth2/v1/token`
// (host derived from the endpoint/component hostname + the `cloud` setting).
// A successful token exchange already proves the credential is valid; the probe
// then makes one lightweight authenticated call — `GET /zia/api/v1/status` — to
// confirm reachability. Runs in-process on the platform with the decrypted
// credential.
//
// Classification:
//   2xx                          -> ok (tenant reachable, credential valid)
//   token endpoint 400/401/403   -> auth failed (bad Client ID / Secret)
//   ZIA API 401/403              -> auth failed (valid client, missing ZIA role)
//   404 (token host or ZIA API)  -> wrong endpoint (vanity / cloud mismatch)
//   other HTTP                   -> HTTP error
//   network / DNS / timeout      -> unreachable
//
// The high-level client swallows token-exchange failures into a synthetic
// `status: 0` response whose body carries the login-host reason (including its
// HTTP status), so `status === 0` is decoded from that reason string.
// =============================================================================

function describeNetworkError(msg: string, host: string): string {
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Zscaler at ${host}. Check the tenant vanity domain, cloud setting and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns|EAI_AGAIN/i.test(msg)) return `Could not resolve ${host}. Check the tenant vanity domain and the "cloud" setting.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${host}.`
  if (/ECONNRESET/i.test(msg)) return `Connection reset by ${host}.`
  if (/certificate|self.signed|SSL|TLS/i.test(msg)) return `TLS error reaching ${host}: ${msg}`
  return `Could not reach Zscaler at ${host}: ${msg}`
}

export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = (ctx.endpoint || ctx.component?.hostname || '').trim()
  if (!host) {
    return {
      ok: false,
      message: 'No Zscaler tenant / endpoint is configured for this connection. Set the component hostname to your Zidentity vanity domain (e.g. "acme" or "acme.zslogin.net").',
    }
  }

  if (!resolveZscalerCredentials(ctx.credential)) {
    return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const built = buildZscalerClient(host, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { ok: false, message: built.error }
  }
  const { client, vanity } = built

  const { cloud } = readZscalerSettings(ctx.settings)
  const hosts = resolveHosts(cloud)
  const apiHost = hosts.apiHost
  const loginHost = hosts.loginHost(vanity)
  const cloudLabel = cloud || 'commercial'
  const baseDetails = [`Tenant: ${vanity}`, `Cloud: ${cloudLabel}`, `API host: ${apiHost}`]

  const started = Date.now()
  try {
    // Lightweight authenticated probe: exchanges the OAuth2 client-credentials
    // pair for a bearer, then calls GET /zia/api/v1/status.
    const res = await client.activationStatus()
    const latencyMs = Date.now() - started

    if (res.ok) {
      return {
        ok: true,
        message: `Connected to Zscaler tenant "${vanity}".`,
        details: [...baseDetails, 'Auth: OneAPI OAuth2 (client credentials)'],
        latencyMs,
      }
    }

    // status === 0: the token exchange failed before any ZIA call. The reason
    // carries the login-host outcome (its HTTP status, or a network error).
    if (res.status === 0) {
      const reason = parseJson<{ reason?: string }>(res.body)?.reason ?? res.body
      const tokenHttp = /HTTP\s+(\d{3})/.exec(reason)?.[1]
      if (tokenHttp === '400' || tokenHttp === '401' || tokenHttp === '403') {
        return {
          ok: false,
          message: 'Zscaler rejected the API client credential (HTTP ' + tokenHttp + '). Check the Client ID and Client Secret.',
          details: [`Tenant: ${vanity}`, `Login host: ${loginHost}`, reason],
          latencyMs,
        }
      }
      if (tokenHttp === '404') {
        return {
          ok: false,
          message: `The Zidentity login endpoint for tenant "${vanity}" was not found (404). Check the vanity domain and "cloud" setting.`,
          details: [`Tenant: ${vanity}`, `Login host: ${loginHost}`, reason],
          latencyMs,
        }
      }
      // No HTTP status in the reason => a network/DNS/timeout error, or a
      // malformed token response.
      return {
        ok: false,
        message: describeNetworkError(reason, loginHost),
        details: [`Tenant: ${vanity}`, `Login host: ${loginHost}`, reason],
        latencyMs,
      }
    }

    // Token succeeded, but the ZIA API rejected or could not serve the request.
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `Zscaler accepted the credential but rejected the request (HTTP ${res.status}). The API client is valid but is missing the ZIA role/scope.`,
        details: [...baseDetails, zscalerErrorMessage(res)],
        latencyMs,
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        message: `Zscaler API endpoint not found (404) on host ${apiHost}. Check the "cloud" setting.`,
        details: baseDetails,
        latencyMs,
      }
    }
    return {
      ok: false,
      message: `Zscaler returned HTTP ${res.status}.`,
      details: [...baseDetails, zscalerErrorMessage(res)],
      latencyMs,
    }
  } catch (err) {
    // Network errors on the ZIA API host (after a successful token exchange)
    // propagate out of the client — the token-host errors are caught above.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      message: describeNetworkError(msg, apiHost),
      details: baseDetails,
      latencyMs: Date.now() - started,
    }
  }
}

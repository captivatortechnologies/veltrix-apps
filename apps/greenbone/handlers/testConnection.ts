import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { GmpSession, buildGetVersionCommand, parseGmpStatus, parseRootAttributes, DEFAULT_GMP_PORT, GmpError } from '../lib/greenboneApi'

// Local mirror of the SDK's TestConnection contract (see defineConnectionTester),
// declared here so the handler compiles against whatever SDK the platform resolves.
interface TestConnectionContext {
  appId: string
  customerId: string
  endpoint: string | null
  credential: CredentialRef | null
  component: { hostname?: string | null; port?: string | number | null } | null
  connectivity: unknown
  settings: Record<string, unknown>
}
interface TestConnectionResult {
  ok: boolean
  message: string
  details?: string[]
  latencyMs?: number
}

const TIMEOUT_MS = 10_000

/** Strip any scheme/path — GMP speaks to a bare host over a TLS socket, not a URL. */
function resolveHost(ctx: TestConnectionContext): string | null {
  const raw = (ctx.endpoint || ctx.component?.hostname || '').toString().trim()
  if (!raw) return null
  return raw.replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '')
}

function resolvePort(ctx: TestConnectionContext): number {
  const fromSetting = Number(ctx.settings?.gmp_port)
  if (Number.isFinite(fromSetting) && fromSetting > 0) return fromSetting
  const fromComponent = Number(ctx.component?.port)
  if (Number.isFinite(fromComponent) && fromComponent > 0) return fromComponent
  return DEFAULT_GMP_PORT
}

// =============================================================================
// Greenbone — connection test.
//
// Verifies a Connection by opening a GMP-over-TLS socket to gvmd (default 9390),
// authenticating with the stored username/password, and reading <get_version/>.
// A successful authenticate proves both reachability AND that the credential is
// valid. gvmd commonly ships a self-signed cert, so TLS is tolerated (a valid
// cert can be enforced later via a verify_tls setting).
// Verify against a live gvmd — GMP is version-specific and TLS:9390 is the classic
// (now deprecated in newer Greenbone OS) transport.
// =============================================================================
export default async function testConnection(ctx: TestConnectionContext): Promise<TestConnectionResult> {
  const host = resolveHost(ctx)
  if (!host) return { ok: false, message: 'No endpoint is configured for this connection.' }
  if (!ctx.credential) return { ok: false, message: 'No credential is attached to this connection.' }
  if (!ctx.credential.username || !ctx.credential.password) {
    return { ok: false, message: 'Greenbone authenticates over GMP with a username and password — attach both to this connection.' }
  }

  const port = resolvePort(ctx)
  const verifyTls = ctx.settings?.verify_tls === true
  const started = Date.now()
  let session: GmpSession | null = null
  try {
    session = await GmpSession.connect({ host, port, rejectUnauthorized: verifyTls, timeoutMs: TIMEOUT_MS })
    await session.authenticate(ctx.credential.username, ctx.credential.password)
    const raw = await session.send(buildGetVersionCommand())
    const st = parseGmpStatus(raw)
    const version = /<version>([\s\S]*?)<\/version>/.exec(raw)?.[1] ?? parseRootAttributes(raw).status_text ?? 'unknown'
    const latencyMs = Date.now() - started
    if (!st.ok) {
      return { ok: false, message: `Reached gvmd but get_version returned status ${st.status}.`, details: [`Endpoint: ${host}:${port}`], latencyMs }
    }
    return {
      ok: true,
      message: `Connected to Greenbone gvmd (GMP version ${version}).`,
      details: [`Endpoint: ${host}:${port}`, 'Transport: GMP over TLS', 'Auth: username + password'],
      latencyMs,
    }
  } catch (err) {
    const latencyMs = Date.now() - started
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof GmpError && err.status) {
      return { ok: false, message: `Reached gvmd but authentication failed (status ${err.status}${err.statusText ? `: ${err.statusText}` : ''}). Check the username and password.`, details: [`Endpoint: ${host}:${port}`], latencyMs }
    }
    if (/timed?\s?out/i.test(msg)) return { ok: false, message: `Timed out after ${TIMEOUT_MS / 1000}s connecting to ${host}:${port}.`, latencyMs }
    if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return { ok: false, message: `Could not resolve the host "${host}".`, latencyMs }
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, message: `Connection refused by ${host}:${port}. Check the port and that gvmd is listening for GMP over TLS.`, latencyMs }
    if (/self.signed|certificate|CERT_/i.test(msg)) return { ok: false, message: `TLS certificate rejected by ${host}:${port}. gvmd often uses a self-signed cert — turn off "Verify TLS certificate" in settings.`, latencyMs }
    return { ok: false, message: `Could not reach gvmd at ${host}:${port}: ${msg}`, latencyMs }
  } finally {
    session?.close()
  }
}

import { probeSelectedFeatures } from '../lib/readiness'
import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../lib/graph'

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
  identity?: import('../lib/graph').GraphIdentity
  settings: Record<string, unknown>
}
interface TestConnectionResult {
  ok: boolean
  message: string
  details?: string[]
  latencyMs?: number
}

// Organization identity and selected feature READ probes only. Successful reads
// do not prove write authorization, conditional picker access, or feature licensing.

export default async function testConnection(
  ctx: TestConnectionContext
): Promise<TestConnectionResult> {
  const settings = readGraphSettings(ctx.settings)
  if (settings.configurationError) return { ok: false, message: settings.configurationError }
  const cred = resolveGraphCredential(ctx.credential, settings, ctx.identity)
  if (!cred) return { ok: false, message: MISSING_CREDENTIAL_MESSAGE }

  const client = buildGraphClient(cred, settings)
  const details = [`Tenant: ${cred.tenantId}`, `Client ID: ${cred.clientId}`, `Cloud: ${cred.cloud ?? 'global'}`, `Auth: ${cred.certificate ? 'certificate' : cred.identity && !cred.clientSecret ? 'platform broker' : 'client secret'}`]
  const started = Date.now()
  const res = await client.get('/organization?$select=id,displayName')
  const latencyMs = Date.now() - started

  // status 0 means the token exchange or the network request itself failed —
  // the body carries the underlying reason.
  if (res.status === 0) {
    return { ok: false, message: `Microsoft Entra ${res.stage ?? "request"} failed: ${res.body}`, details, latencyMs }
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      message:
        `Microsoft Graph rejected the app registration (HTTP ${res.status}). Check the client secret and that ` +
        `admin consent was granted for the required application permissions.`,
      details,
      latencyMs,
    }
  }
  if (res.ok) {
    const org = parseJson<{ value?: Array<{ id?: string; displayName?: string }> }>(res.body)
    const organization = org?.value?.[0]
    if (!organization?.id) return { ok: false, message: 'Microsoft Graph organization response was incomplete; tenant identity not verified.', details, latencyMs }
    if (/^[0-9a-f-]{36}$/i.test(cred.tenantId) && organization.id.toLowerCase() !== cred.tenantId.toLowerCase()) {
      return { ok: false, message: 'Microsoft Graph returned a different tenant than the configured connection. Refusing to report readiness.', details, latencyMs }
    }
    const name = organization.displayName
    const selected = String(ctx.settings.readiness_features ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const checks = await probeSelectedFeatures(client, selected)
    return {
      ok: checks.every(c => c.ok),
      message: `Connected to Microsoft Entra${name ? ` tenant "${name}"` : ''}. ${checks.some(c => !c.ok) ? "Selected feature checks failed." : "Organization read verified; write access and licensing remain unverified."}`,
      details: [...details, ...(name ? [`Tenant name: ${name}`] : []), ...checks.map(c => c.detail)],
      latencyMs: Date.now() - started,
    }
  }
  return { ok: false, message: `Microsoft Graph returned HTTP ${res.status}: ${graphErrorMessage(res)}`, details, latencyMs }
}

import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import {
  buildAuthentikUrl,
  buildApiBase,
  resolveApiToken,
  resolveVerifyTls,
  findByField,
  authentikRequest,
  bearer,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/authentikApi'
import type { AuthentikBrand } from './_shared'

/** Health for brands: reachability + token, then per-item existence by domain. */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const checks: HealthCheck[] = []
  const items = canvas.items ?? canvas.sections ?? []

  const token = resolveApiToken(credential)
  if (!token) {
    checks.push({ name: 'credential', passed: false, message: MISSING_CREDENTIAL_MESSAGE })
    return { healthy: false, score: 0, checks }
  }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)
  const listUrl = `${base}/core/brands/`
  const started = Date.now()

  try {
    const res = await authentikRequest(`${listUrl}?page_size=1`, { headers: bearer(token), verifyTls })
    checks.push({
      name: 'authentik_reachable',
      passed: res.ok,
      message: res.ok ? `authentik reachable at ${base} and the API token was accepted.` : `authentik returned HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      latencyMs: Date.now() - started,
    })
    if (!res.ok) return { healthy: false, score: 0, checks }
  } catch (error) {
    checks.push({ name: 'authentik_reachable', passed: false, message: `authentik unreachable: ${error instanceof Error ? error.message : 'error'}`, latencyMs: Date.now() - started })
    return { healthy: false, score: 0, checks }
  }

  for (const item of items) {
    const domain = String(item.fields.domain ?? '').trim()
    if (!domain) continue
    const itemStarted = Date.now()
    try {
      const found = await findByField<AuthentikBrand>(listUrl, token, 'domain', domain, { verifyTls })
      checks.push({
        name: `brand:${domain}`,
        passed: found != null,
        message: found != null ? `Brand "${domain}" is present.` : `Brand "${domain}" is missing.`,
        latencyMs: Date.now() - itemStarted,
      })
    } catch (error) {
      checks.push({ name: `brand:${domain}`, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - itemStarted })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100), checks }
}

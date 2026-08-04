import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import {
  buildAuthentikUrl,
  buildApiBase,
  resolveApiToken,
  resolveVerifyTls,
  findByName,
  authentikRequest,
  bearer,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/authentikApi'
import { POLICY_ENDPOINT_SEGMENT, readPolicyType, type AuthentikPolicy } from './_shared'

/**
 * Health for policies: reachability + token (probed against the expression
 * endpoint), then per-item existence within its OWN type's endpoint.
 */
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
  const started = Date.now()

  try {
    const res = await authentikRequest(`${base}/policies/expression/?page_size=1`, { headers: bearer(token), verifyTls })
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
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const type = readPolicyType(item.fields.type)
    const listUrl = `${base}/policies/${POLICY_ENDPOINT_SEGMENT[type]}/`
    const itemStarted = Date.now()
    try {
      const found = await findByName<AuthentikPolicy>(listUrl, token, name, { verifyTls })
      checks.push({
        name: `policy:${name}`,
        passed: found != null,
        message: found != null ? `Policy "${name}" (${type}) is present.` : `Policy "${name}" (${type}) is missing.`,
        latencyMs: Date.now() - itemStarted,
      })
    } catch (error) {
      checks.push({ name: `policy:${name}`, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - itemStarted })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100), checks }
}

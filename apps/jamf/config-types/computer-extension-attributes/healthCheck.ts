import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listExtensionAttributes } from './deploy'
import { extensionAttributeKey, extractExtensionAttributeSpecs, indexExtensionAttributesByName, type LiveExtensionAttribute } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'jamf_credential', passed: false, message: built.error }] }
  }
  const { client, apiBase } = built

  const specs = extractExtensionAttributeSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('jamf_reachable', async () => {
    const live = await listExtensionAttributes(client, ctx.settings)
    return { message: `Jamf Pro reachable at ${apiBase}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const byName = indexExtensionAttributesByName(reachable.live)
    for (const spec of specs) {
      const present = byName.has(extensionAttributeKey(spec.name))
      checks.push({
        name: `extension-attribute:${spec.name}`,
        passed: present,
        message: present ? `Extension attribute "${spec.name}" is present` : `Extension attribute "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveExtensionAttribute[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveExtensionAttribute[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}

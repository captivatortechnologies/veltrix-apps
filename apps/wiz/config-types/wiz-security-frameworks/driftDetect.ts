import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listCustomSecurityFrameworks, readFramework } from './deploy'
import { extractSecurityFrameworkSpecs, frameworkKey, type LiveSecurityFramework } from './validate'

/**
 * Detect drift between the deployed security-framework configuration and the live
 * tenant. Re-finds each declared framework by name and diffs the managed fields:
 * a missing framework is critical drift; a changed enabled state or category
 * count is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSecurityFrameworkSpecs(ctx.deployedConfig).filter((s) => s.name && Array.isArray(s.categories))
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listCustomSecurityFrameworks(client)
    const byName = new Map<string, LiveSecurityFramework>(
      live.filter((f) => f.name).map((f) => [frameworkKey(f.name as string), f]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(frameworkKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      const full = await readFramework(client, found.id)
      const liveEnabled = full.enabled ?? true
      if (liveEnabled !== spec.enabled) {
        diffs.push({ field: `${label}.enabled`, expected: String(spec.enabled), actual: String(liveEnabled), severity: 'warning' })
      }
      const declaredCount = Array.isArray(spec.categories) ? spec.categories.length : 0
      const liveCount = Array.isArray(full.categories) ? full.categories.length : 0
      if (declaredCount !== liveCount) {
        diffs.push({
          field: `${label}.categories`,
          expected: `${declaredCount} categor${declaredCount === 1 ? 'y' : 'ies'}`,
          actual: `${liveCount} categor${liveCount === 1 ? 'y' : 'ies'}`,
          severity: 'warning',
        })
      }

      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id,
        targetName: spec.name,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'wiz',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { searchAllJobs } from './deploy'
import { extractJobSpecs, type LiveJob } from './validate'

/**
 * Detect drift between the deployed job configuration and the live server.
 * A missing job is critical drift; a changed cron schedule, playbook or
 * disabled flag is informational drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractJobSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await searchAllJobs(client)
    const byName = new Map<string, LiveJob>(live.filter((j) => j.name).map((j) => [j.name as string, j]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const liveCron = typeof found.cron === 'string' ? found.cron : ''
      if ((spec.cron ?? '') !== liveCron) {
        diffs.push({ field: `${spec.name}.cron`, expected: spec.cron ?? 'not set', actual: liveCron || 'not set', severity: 'info' })
      }
      const livePlaybook = typeof found.playbookId === 'string' ? found.playbookId : ''
      if ((spec.playbookId ?? '') !== livePlaybook) {
        diffs.push({
          field: `${spec.name}.playbookId`,
          expected: spec.playbookId ?? 'not set',
          actual: livePlaybook || 'not set',
          severity: 'info',
        })
      }
      const liveDisabled = found.disabled ?? false
      if (liveDisabled !== spec.disabled) {
        diffs.push({ field: `${spec.name}.disabled`, expected: String(spec.disabled), actual: String(liveDisabled), severity: 'info' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'cortex-xsoar',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

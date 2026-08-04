import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, JUMPCLOUD_API_BASE } from '../../lib/jumpcloudApi'
import { listCommands } from './deploy'
import { extractCommandSpecs, findCommandByName } from './_shared'

const COMPARED_FIELDS = [
  'description', 'command', 'commandType', 'shell', 'user', 'launchType', 'schedule', 'scheduleRepeatType', 'trigger', 'timeout',
] as const

/**
 * Detect drift between the deployed Command configuration and the live org.
 * Re-finds each declared command by name and diffs every managed scalar field
 * plus `sudo` and the `commandRunners` set. Best-effort: if the org can't be
 * read the check reports no drift rather than raising a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings, { baseUrl: JUMPCLOUD_API_BASE })
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractCommandSpecs(ctx.deployedConfig).filter((s) => s.name)

  let liveCommands
  try {
    liveCommands = await listCommands(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort
  }

  for (const spec of specs) {
    const live = findCommandByName(liveCommands, spec.name)
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    for (const field of COMPARED_FIELDS) {
      const liveValue = String(live[field] ?? '')
      const desiredValue = spec[field]
      if (liveValue !== desiredValue) {
        diffs.push({ field: `${spec.name}.${field}`, expected: desiredValue, actual: liveValue, severity: 'info' })
      }
    }

    if (Boolean(live.sudo) !== spec.sudo) {
      diffs.push({ field: `${spec.name}.sudo`, expected: String(spec.sudo), actual: String(Boolean(live.sudo)), severity: 'warning' })
    }

    const liveRunners = new Set((live.commandRunners ?? []).map((id) => id.trim().toLowerCase()))
    const desiredRunners = new Set(spec.commandRunners.map((id) => id.trim().toLowerCase()))
    const sameRunners = liveRunners.size === desiredRunners.size && [...desiredRunners].every((id) => liveRunners.has(id))
    if (!sameRunners) {
      diffs.push({
        field: `${spec.name}.commandRunners`,
        expected: [...desiredRunners].sort().join(', ') || '(none)',
        actual: [...liveRunners].sort().join(', ') || '(none)',
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

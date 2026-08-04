import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { attachDriftActor, veltrixActorLogins } from '../lib/xsoarAudit'
import { buildFieldId, fieldsOfKind, listFields, type LiveField } from '../lib/xsoarFields'
import { extractFieldSpecs } from './validate'

const KIND = 'incident' as const

/**
 * Detect drift between the deployed incident-field configuration and the live
 * server. A missing field is critical drift; a changed type, required flag or
 * associated-types scope is informational drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractFieldSpecs(ctx.deployedConfig).filter((s) => s.cliName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = fieldsOfKind(await listFields(client), KIND)
    const byId = new Map<string, LiveField>(live.filter((f) => f.id).map((f) => [f.id as string, f]))

    for (const spec of specs) {
      const before = diffs.length
      const id = buildFieldId(KIND, spec.cliName)
      const found = byId.get(id)
      if (!found) {
        diffs.push({ field: spec.cliName, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.cliName, excludeActorLogins })
        continue
      }
      if (typeof found.type === 'string' && found.type !== spec.type) {
        diffs.push({ field: `${spec.cliName}.type`, expected: spec.type, actual: found.type, severity: 'info' })
      }
      if (typeof found.required === 'boolean' && found.required !== spec.required) {
        diffs.push({
          field: `${spec.cliName}.required`,
          expected: String(spec.required),
          actual: String(found.required),
          severity: 'info',
        })
      }
      if (typeof found.associatedToAll === 'boolean' && found.associatedToAll !== spec.associatedToAll) {
        diffs.push({
          field: `${spec.cliName}.associatedToAll`,
          expected: String(spec.associatedToAll),
          actual: String(found.associatedToAll),
          severity: 'info',
        })
      }
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id ?? id,
        targetName: spec.cliName,
        resource: found,
        excludeActorLogins,
      })
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

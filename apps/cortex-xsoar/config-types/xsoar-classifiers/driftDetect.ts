import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { attachDriftActor, veltrixActorLogins } from '../lib/xsoarAudit'
import { CLASSIFIER_TYPE, searchClassifications, type LiveClassification } from '../lib/xsoarClassification'
import { extractClassifierSpecs } from './validate'

/**
 * Detect drift between the deployed classifier configuration and the live
 * server. A missing classifier is critical drift; a changed default incident
 * type or feed flag is informational drift. The classification-rules JSON blob
 * is not diffed field-by-field (it is a deep, variable schema) — a live
 * classifier's presence and its typed fields are the reconciled surface.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractClassifierSpecs(ctx.deployedConfig).filter((s) => s.id)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await searchClassifications(client)
    const byId = new Map<string, LiveClassification>(
      live.filter((c) => c.type === CLASSIFIER_TYPE && c.id).map((c) => [c.id as string, c]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const found = byId.get(spec.id)
      if (!found) {
        diffs.push({ field: spec.id, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.id, excludeActorLogins })
        continue
      }
      const expectedDefault = spec.defaultIncidentType ?? ''
      if (typeof found.defaultIncidentType === 'string' && found.defaultIncidentType !== expectedDefault) {
        diffs.push({
          field: `${spec.id}.defaultIncidentType`,
          expected: expectedDefault,
          actual: found.defaultIncidentType,
          severity: 'info',
        })
      }
      if (typeof found.feed === 'boolean' && found.feed !== spec.feed) {
        diffs.push({
          field: `${spec.id}.feed`,
          expected: String(spec.feed),
          actual: String(found.feed),
          severity: 'info',
        })
      }
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id ?? spec.id,
        targetName: spec.id,
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

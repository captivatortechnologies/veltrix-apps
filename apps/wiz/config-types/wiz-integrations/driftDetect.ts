import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { attachDriftActor, veltrixActorLogins } from '../lib/wizAuditLog'
import { listIntegrations } from './deploy'
import { extractIntegrationSpecs, integrationKey, type LiveIntegration } from './validate'

/**
 * Detect drift for integrations: a missing integration is critical drift; a
 * changed type is a warning. Every vendor credential (params) is write-only by
 * design (see canvas.yaml) and is DELIBERATELY NEVER diffed — Wiz's `params` is
 * a union this app never reads back, matching this app's own established
 * "write-only" convention (wiz-service-accounts' generated secret).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractIntegrationSpecs(ctx.deployedConfig).filter((s) => s.name && s.integrationType)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listIntegrations(client)
    const byName = new Map<string, LiveIntegration>(
      live.filter((i) => i.name).map((i) => [integrationKey(i.name as string), i]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byName.get(integrationKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      if ((found.type ?? '') !== spec.integrationType) {
        diffs.push({
          field: `${label}.integration_type`,
          expected: spec.integrationType,
          actual: found.type ?? 'unknown',
          severity: 'warning',
        })
      }

      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: spec.name, excludeActorLogins })
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

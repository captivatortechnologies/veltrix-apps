import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { findConnector } from './deploy'
import { extractConnectorSpecs } from './validate'

/**
 * Detect drift between the deployed connector configuration and the live tenant
 * state. Each declared connector is looked up by name and its NON-SECRET fields
 * are compared.
 *
 * SECRET-BEARING: a connector's `params` hold the cloud credentials and are
 * WRITE-ONLY — Tenable never returns them on GET, so there is nothing to diff
 * them against. We therefore diff ONLY name, type and network, and NEVER
 * params. (`name` is the exact key we look the connector up by, so a name
 * mismatch surfaces as "missing" rather than a field diff; `type` and
 * `network` are the remaining non-secret, comparable fields.)
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractConnectorSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      // Looking up by name covers the `name` field — a miss is reported as
      // missing below rather than as a name diff.
      const live = await findConnector(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      // type — the cloud provider the connector syncs from.
      const liveType = (live.type ?? '').trim().toLowerCase()
      if (spec.type !== liveType) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: spec.type,
          actual: liveType || 'not set',
          severity: 'warning',
        })
      }

      // network — the create body's `network_uuid` is echoed back as
      // `network_id`. An unset network on the canvas is not compared (Tenable
      // fills in the default network, which is not drift the user declared).
      if (spec.networkUuid) {
        const liveNetwork = (live.network_id ?? '').trim()
        if (spec.networkUuid !== liveNetwork) {
          diffs.push({
            field: `${spec.name}.network`,
            expected: spec.networkUuid,
            actual: liveNetwork || 'not set',
            severity: 'warning',
          })
        }
      }

      // params are SECRET (write-only) — deliberately NOT diffed.

      // Attribute every diff this connector produced to the last change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: live.id,
        targetName: spec.name,
        excludeActorLogins,
      })
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

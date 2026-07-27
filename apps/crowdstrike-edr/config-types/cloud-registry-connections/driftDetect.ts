import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findByAlias, listRegistries } from './deploy'
import { extractRegistrySpecs, REGISTRY_STATE_DISABLED, REGISTRY_STATE_ENABLED } from './validate'

/**
 * Detect drift between the deployed registry connection configuration and the
 * live tenant state. Compares ONLY non-secret fields — url and type (verified
 * fields), plus scan settings (state/scan_interval) best-effort when the live
 * entity reports them. The credential (username/password/token) is NEVER read,
 * compared, or surfaced.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractRegistrySpecs(ctx.deployedConfig).filter((s) => s.name && s.url && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: Awaited<ReturnType<typeof listRegistries>> = []
  try {
    live = await listRegistries(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'registries',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    const before = diffs.length
    const found = findByAlias(live, spec.name)

    if (!found) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    // url — the registry endpoint (verified field, always compared)
    if ((found.url ?? '') !== spec.url) {
      diffs.push({
        field: `${spec.name}.url`,
        expected: spec.url,
        actual: found.url ?? 'not set',
        severity: 'warning',
      })
    }

    // type — the provider kind (verified field, always compared)
    if ((found.type ?? '').toLowerCase() !== spec.type) {
      diffs.push({
        field: `${spec.name}.type`,
        expected: spec.type,
        actual: found.type ?? 'not set',
        severity: 'warning',
      })
    }

    // Scan settings — best-effort: only flag when the live entity reports the
    // field, so an unmodeled field name never produces false drift.
    if (found.state !== undefined) {
      const expectedState = spec.enabled ? REGISTRY_STATE_ENABLED : REGISTRY_STATE_DISABLED
      if (found.state !== expectedState) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: expectedState,
          actual: found.state,
          severity: 'warning',
        })
      }
    }
    if (found.scan_interval !== undefined && spec.scanInterval !== undefined) {
      if (found.scan_interval !== spec.scanInterval) {
        diffs.push({
          field: `${spec.name}.scanInterval`,
          expected: spec.scanInterval,
          actual: found.scan_interval,
          severity: 'info',
        })
      }
    }

    // Attribute every diff this registry produced to Falcon's recorded last
    // modifier (once) — no-op when nothing drifted or the change was ours.
    attachDriftActor(diffs.slice(before), found, { excludeActorLogins })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

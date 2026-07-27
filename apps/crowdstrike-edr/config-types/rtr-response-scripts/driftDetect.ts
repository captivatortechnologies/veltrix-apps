import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findScript } from './deploy'
import { extractScriptSpecs, normalizePlatforms, type LiveRtrScript, type ScriptSpec } from './validate'

/**
 * Detect drift between the deployed RTR custom-script configuration and the
 * live tenant state. Looks up each declared script and diffs its managed
 * fields: permission_type, platform, description, and content (compared as a
 * trimmed string, and only when GET returns it).
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

  const specs = extractScriptSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findScript(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...diffScript(spec, live))

      // Attribute every diff this script produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
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

function diffScript(spec: ScriptSpec, live: LiveRtrScript): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const label = spec.name

  if ((live.permission_type ?? '') !== spec.permissionType) {
    diffs.push({
      field: `${label}.permissionType`,
      expected: spec.permissionType,
      actual: live.permission_type ?? 'not set',
      severity: 'warning',
    })
  }

  const livePlatforms = normalizePlatforms(live.platform)
  if (!sameSet(livePlatforms, [spec.platform])) {
    diffs.push({
      field: `${label}.platform`,
      expected: spec.platform,
      actual: livePlatforms.join(', ') || 'not set',
      severity: 'warning',
    })
  }

  const liveDescription = (live.description ?? '').trim()
  if (spec.description.trim() !== liveDescription) {
    diffs.push({
      field: `${label}.description`,
      expected: spec.description || 'not set',
      actual: liveDescription || 'not set',
      severity: 'info',
    })
  }

  // Content is only diffed when the API actually returned it — the script body
  // can be large, so drift reports a summary rather than echoing it.
  if (typeof live.content === 'string' && spec.content.trim() !== live.content.trim()) {
    diffs.push({
      field: `${label}.content`,
      expected: 'declared script content',
      actual: 'differs from declared script content',
      severity: 'warning',
    })
  }

  return diffs
}

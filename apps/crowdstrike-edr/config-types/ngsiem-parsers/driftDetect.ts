import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findParserByName } from './deploy'
import { extractParserSpecs } from './validate'

/**
 * Detect drift between the deployed parser configuration and the live tenant
 * state. Compares the parser script (as a trimmed string) and repository — the
 * fields this app writes. datatype/enabled are not written to the verified JSON
 * endpoint, so they are not compared.
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

  const specs = extractParserSpecs(ctx.deployedConfig).filter((s) => s.name && s.script.trim())

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findParserByName(client, spec.name, spec.repository)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // The parser script is the whole configuration — compare it as a trimmed
      // string. Only compare when the API actually returned a script (an API
      // that omits it must not read as permanent drift).
      if (typeof live.script === 'string' && live.script.trim() !== spec.script.trim()) {
        diffs.push({
          field: `${spec.name}.script`,
          expected: 'declared parser script',
          actual: 'differs from declared parser script',
          severity: 'critical',
        })
      }

      if (typeof live.repository === 'string' && live.repository !== spec.repository) {
        diffs.push({
          field: `${spec.name}.repository`,
          expected: spec.repository,
          actual: live.repository,
          severity: 'warning',
        })
      }

      // Attribute every diff this parser produced to Falcon's recorded last
      // modifier (once) — best-effort, no-op when nothing drifted or the
      // change was ours (or the modifier fields are absent).
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

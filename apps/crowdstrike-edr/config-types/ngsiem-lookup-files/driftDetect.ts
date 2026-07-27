import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findLookupFile } from './deploy'
import { extractLookupSpecs } from './validate'

/**
 * Detect drift between the deployed lookup file configuration and the live
 * tenant state. Compares CSV content as a trimmed string — the field this app
 * writes. Key columns are a query-time concept the API does not store, so they
 * are not compared.
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

  const specs = extractLookupSpecs(ctx.deployedConfig).filter((s) => s.filename && s.content.trim())

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findLookupFile(client, spec.filename, spec.repository)

      if (!live) {
        diffs.push({
          field: spec.filename,
          expected: 'exists',
          actual: 'missing',
          severity: 'critical',
        })
        continue
      }

      // The CSV content is the whole configuration — compare it as a trimmed
      // string. Only compare when the API actually returned content (an API
      // that omits it must not read as permanent drift).
      if (typeof live.content === 'string' && live.content.trim() !== spec.content.trim()) {
        diffs.push({
          field: `${spec.filename}.content`,
          expected: 'declared CSV content',
          actual: 'differs from declared CSV content',
          severity: 'warning',
        })
      }

      // Attribute every diff this file produced to Falcon's recorded last
      // modifier (once) — best-effort, no-op when nothing drifted or the
      // change was ours (or the modifier fields are absent).
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.filename,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { contentMatches, findPutFile } from './deploy'
import { extractPutFileSpecs, type LiveRtrPutFile, type PutFileSpec } from './validate'

/**
 * Detect drift between the deployed RTR put-file configuration and the live
 * tenant state. Looks up each declared put-file and diffs its description and
 * content. The RTR Admin API never returns a put-file's bytes, so content is
 * compared via the live `sha256` (only when the API returned one).
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

  const specs = extractPutFileSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findPutFile(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffs.push(...(await diffPutFile(spec, live)))

      // Attribute every diff this put-file produced to Falcon's recorded last
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

async function diffPutFile(spec: PutFileSpec, live: LiveRtrPutFile): Promise<DriftDiff[]> {
  const diffs: DriftDiff[] = []
  const label = spec.name

  const liveDescription = (live.description ?? '').trim()
  if (spec.description.trim() !== liveDescription) {
    diffs.push({
      field: `${label}.description`,
      expected: spec.description || 'not set',
      actual: liveDescription || 'not set',
      severity: 'info',
    })
  }

  // The bytes are never returned — compare content by SHA-256, and only when
  // the API gave us one to compare against.
  if (typeof live.sha256 === 'string' && live.sha256.trim()) {
    const unchanged = await contentMatches(spec.content, live.sha256)
    if (!unchanged) {
      diffs.push({
        field: `${label}.content`,
        expected: 'declared file content',
        actual: 'differs from declared file content (sha256 mismatch)',
        severity: 'warning',
      })
    }
  }

  return diffs
}

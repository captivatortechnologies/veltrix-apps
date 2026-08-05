import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTinesClient } from '../../lib/tinesApi'
import { extractCredentialSpecs, findCredential } from './_shared'
import { listCredentials } from './deploy'

/**
 * Detect drift between the deployed Credentials configuration and the live
 * Tines tenant. Re-finds each declared credential by (team, name):
 *   - a missing credential is CRITICAL drift
 *   - a changed mode or description is INFO drift
 * Secret material is NEVER compared — Tines never returns it (write-only,
 * see _shared.ts). Best-effort — an unreadable team raises no false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractCredentialSpecs(ctx.deployedConfig).filter((s) => s.name && s.teamId)
  if (specs.length === 0) return { hasDrift: false, diffs }

  const cache = new Map<string, Awaited<ReturnType<typeof listCredentials>>>()
  for (const spec of specs) {
    let live = cache.get(spec.teamId)
    if (!live) {
      try {
        live = await listCredentials(client, spec.teamId)
        cache.set(spec.teamId, live)
      } catch {
        continue
      }
    }

    const match = findCredential(live, spec.teamId, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }
    if (spec.mode && String(match.mode ?? '') !== spec.mode) {
      diffs.push({ field: `${spec.name}.mode`, expected: spec.mode, actual: String(match.mode ?? ''), severity: 'info' })
    }
    if (spec.description && String(match.description ?? '') !== spec.description) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description,
        actual: String(match.description ?? ''),
        severity: 'info',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

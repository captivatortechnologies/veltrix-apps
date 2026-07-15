import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { findMount, getMountTune, readOptionVersion } from './deploy'
import { KV_ENGINE_TYPE, extractMountSpecs, parseDurationSeconds } from './validate'

/**
 * Detect drift between the deployed secret engine configuration and the live
 * cluster. Re-reads each mount from GET /sys/mounts (type/description/options)
 * and, when the canvas manages a TTL, GET /sys/mounts/{path}/tune.
 *
 *   - type            → critical (a different engine occupies the path)
 *   - options.version → critical AND UNFIXABLE: a KV version is set at enable
 *                       time and cannot be changed without recreating the mount
 *                       (which destroys its data). Flagged clearly so an operator
 *                       does not expect a redeploy to converge it.
 *   - description     → info (converges on the next tune)
 *   - lease TTLs      → warning (normalized to seconds before comparing)
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractMountSpecs(ctx.deployedConfig).filter((s) => s.path && s.type)

  for (const spec of specs) {
    try {
      const live = await findMount(client, spec.path)

      if (!live) {
        diffs.push({ field: spec.path, expected: 'mounted', actual: 'missing', severity: 'critical' })
        continue
      }

      // type — immutable; a mismatch means a different engine is at this path.
      const liveType = (live.type ?? '').toLowerCase()
      if (liveType !== spec.type) {
        diffs.push({ field: `${spec.path}.type`, expected: spec.type, actual: liveType || 'unknown', severity: 'critical' })
      }

      // KV version / options — set at enable time and immutable, so a mismatch is
      // UNFIXABLE by a redeploy. Flag it clearly (critical) and say why.
      if (spec.type === KV_ENGINE_TYPE && spec.kvVersion) {
        const liveVersion = readOptionVersion(live.options)
        if (liveVersion && liveVersion !== spec.kvVersion) {
          diffs.push({
            field: `${spec.path}.options.version`,
            expected: `${spec.kvVersion} (immutable — a KV version is fixed at enable time and cannot be changed without recreating the mount, which destroys its data)`,
            actual: liveVersion,
            severity: 'critical',
          })
        }
      }

      // description — a managed field that converges on the next tune.
      const liveDescription = (typeof live.description === 'string' ? live.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.path}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // lease TTLs — only the ones the canvas manages, normalized to seconds.
      if (spec.defaultLeaseTtl !== undefined || spec.maxLeaseTtl !== undefined) {
        const tune = await getMountTune(client, spec.path)
        compareTtl(diffs, `${spec.path}.defaultLeaseTtl`, spec.defaultLeaseTtl, tune?.default_lease_ttl)
        compareTtl(diffs, `${spec.path}.maxLeaseTtl`, spec.maxLeaseTtl, tune?.max_lease_ttl)
      }
    } catch (error) {
      diffs.push({
        field: spec.path,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Coerce a live TTL (Vault echoes seconds as a number or numeric string) to seconds. */
function toSeconds(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  return parseDurationSeconds(value)
}

/** Compare a canvas TTL to a live TTL in seconds, pushing a warning-level diff. */
function compareTtl(
  diffs: DriftDiff[],
  field: string,
  expectedRaw: string | undefined,
  liveRaw: number | string | undefined,
): void {
  if (expectedRaw === undefined) return
  const expected = parseDurationSeconds(expectedRaw)
  // An unparseable canvas TTL is caught by validate — don't invent drift here.
  if (expected === undefined) return
  const actual = toSeconds(liveRaw)
  if (expected !== actual) {
    diffs.push({
      field,
      expected: `${expectedRaw} (${expected}s)`,
      actual: actual !== undefined ? `${actual}s` : 'not set',
      severity: 'warning',
    })
  }
}

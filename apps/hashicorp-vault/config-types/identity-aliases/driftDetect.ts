import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { findAliasByLabel } from './deploy'
import { aliasKey, extractIdentityAliasSpecs, type AliasKind } from './validate'

/**
 * Detect drift between the deployed identity alias configuration and the live
 * cluster. Each alias is re-found by its (mount_accessor, name) LABEL — the
 * same reconciliation deploy uses, since an alias has no addressable name —
 * then only `canonical_id` is diffed (name and mount_accessor are the match
 * key itself and cannot drift without becoming a different alias).
 *
 * A missing alias is `critical`. A changed canonical_id is `warning` — it
 * converges on the next deploy.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractIdentityAliasSpecs(ctx.deployedConfig).filter(
    (s) => s.kind && s.name && s.canonicalId && s.mountAccessor,
  )

  for (const spec of specs) {
    const kind = spec.kind as AliasKind
    const label = aliasKey(kind, spec.mountAccessor, spec.name)
    try {
      const live = await findAliasByLabel(client, kind, spec.mountAccessor, spec.name)

      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if ((live.canonical_id ?? '') !== spec.canonicalId) {
        diffs.push({
          field: `${label}.canonicalId`,
          expected: spec.canonicalId,
          actual: live.canonical_id || 'not set',
          severity: 'warning',
        })
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

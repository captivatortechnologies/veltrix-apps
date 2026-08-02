import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, searchAliases, type LiveAlias } from '../../lib/opnsenseApi'
import { aliasKey, extractAliasSpecs, liveContentList, sameEntrySet } from './_shared'

/**
 * Detect drift between the deployed alias configuration and the live
 * OPNsense box. Re-finds each declared alias by name (searchItem) and diffs
 * the managed fields: a missing alias is critical drift; a changed type,
 * content set, description, protocol filter, tracked interface or enabled
 * state is a warning. Read-only — never stages or applies a change.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractAliasSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await searchAliases(client)
    const byName = new Map<string, LiveAlias>(live.filter((a) => a.name).map((a) => [aliasKey(a.name as string), a]))

    for (const spec of specs) {
      const found = byName.get(aliasKey(spec.name))
      const label = spec.name

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveEnabled = String(found.enabled ?? '1') === '1'
      if (liveEnabled !== spec.enabled) {
        diffs.push({
          field: `${label}.enabled`,
          expected: spec.enabled ? 'enabled' : 'disabled',
          actual: liveEnabled ? 'enabled' : 'disabled',
          severity: 'warning',
        })
      }

      const liveType = String(found.type ?? '')
      if (spec.type && liveType !== spec.type) {
        diffs.push({ field: `${label}.type`, expected: spec.type, actual: liveType || '(none)', severity: 'critical' })
      }

      const liveContent = liveContentList(found)
      if (!sameEntrySet(liveContent, spec.content)) {
        diffs.push({
          field: `${label}.content`,
          expected: spec.content.join(', ') || '(none)',
          actual: liveContent.join(', ') || '(none)',
          severity: 'warning',
        })
      }

      const liveDescription = String(found.description ?? '')
      if (liveDescription !== spec.description) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description || '(none)',
          actual: liveDescription || '(none)',
          severity: 'warning',
        })
      }

      const liveProto = String(found.proto ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
      if (!sameEntrySet(liveProto, spec.proto)) {
        diffs.push({
          field: `${label}.proto`,
          expected: spec.proto.join(', ') || '(any)',
          actual: liveProto.join(', ') || '(any)',
          severity: 'warning',
        })
      }

      const liveInterface = String(found.interface ?? '')
      if (liveInterface !== spec.interface) {
        diffs.push({
          field: `${label}.interface`,
          expected: spec.interface || '(none)',
          actual: liveInterface || '(none)',
          severity: 'warning',
        })
      }
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

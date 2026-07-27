import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import type { LiveSource } from '../sources/validate'
import { extractSourceSchemaSpecs, type LiveSourceSchema } from './validate'

const SOURCES = '/v3/sources'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractSourceSchemaSpecs(ctx.deployedConfig).filter((s) => s.name && s.sourceName)
  const sourcesRes = await client.getAll<LiveSource>(SOURCES)
  if (!sourcesRes.ok) return { hasDrift: false, diffs: [] }
  const sourceByName = new Map(sourcesRes.items.filter((s) => s.name && s.id).map((s) => [s.name!.toLowerCase(), s]))

  const childCache = new Map<string, Map<string, LiveSourceSchema>>()
  const diffs: Diffs = []
  for (const spec of specs) {
    const source = sourceByName.get(spec.sourceName.toLowerCase())
    if (!source?.id) {
      diffs.push({ field: `${spec.sourceName}/${spec.name}`, expected: 'present', actual: 'source absent', severity: 'critical' })
      continue
    }
    let children = childCache.get(source.id)
    if (!children) {
      const listed = await client.getAll<LiveSourceSchema>(`${SOURCES}/${source.id}/schemas`)
      children = new Map(listed.items.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))
      childCache.set(source.id, children)
    }
    const live = children.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: `${spec.sourceName}/${spec.name}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.identityAttribute && (live.identityAttribute ?? '') !== spec.identityAttribute) {
      diffs.push({ field: `${spec.sourceName}/${spec.name}.identityAttribute`, expected: spec.identityAttribute, actual: live.identityAttribute ?? '', severity: 'warning' })
    }
    if (spec.displayAttribute && (live.displayAttribute ?? '') !== spec.displayAttribute) {
      diffs.push({ field: `${spec.sourceName}/${spec.name}.displayAttribute`, expected: spec.displayAttribute, actual: live.displayAttribute ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

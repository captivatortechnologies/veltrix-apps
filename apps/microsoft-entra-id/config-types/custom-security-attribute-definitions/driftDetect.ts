import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { definitionId, extractAttributeDefinitionSpecs, type LiveAttributeDefinition } from './validate'

const BASE = '/directory/customSecurityAttributeDefinitions'
const SELECT = '?$select=id,status,usePreDefinedValuesOnly,description'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAttributeDefinitionSpecs(ctx.deployedConfig).filter((s) => s.attributeSet && s.name)
  const listed = await client.getAll<LiveAttributeDefinition>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveById = new Map(listed.items.filter((d) => d.id).map((d) => [d.id!.toLowerCase(), d]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const id = definitionId(spec)
    const live = liveById.get(id.toLowerCase())
    if (!live) {
      diffs.push({ field: id, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.status !== (live.status ?? 'Available')) {
      diffs.push({ field: `${id}.status`, expected: spec.status, actual: live.status ?? 'Available', severity: 'warning' })
    }
    if (spec.usePreDefinedValuesOnly !== (live.usePreDefinedValuesOnly === true)) {
      diffs.push({
        field: `${id}.usePreDefinedValuesOnly`,
        expected: String(spec.usePreDefinedValuesOnly),
        actual: String(live.usePreDefinedValuesOnly === true),
        severity: 'warning',
      })
    }
    if ((spec.description || '') !== (live.description ?? '')) {
      diffs.push({
        field: `${id}.description`,
        expected: spec.description || '',
        actual: live.description ?? '',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

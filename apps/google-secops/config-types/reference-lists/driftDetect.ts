import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractReferenceListSpecs, mapSyntaxType, type LiveReferenceList } from './validate'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractReferenceListSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/referenceLists/${encodeURIComponent(spec.name)}?view=REFERENCE_LIST_VIEW_FULL`)
    if (getRes.status === 404) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) continue
    const live = parseJson<LiveReferenceList>(getRes.body)
    if (live?.syntaxType && live.syntaxType !== mapSyntaxType(spec.syntax)) {
      diffs.push({ field: `${spec.name}.syntaxType`, expected: mapSyntaxType(spec.syntax), actual: live.syntaxType, severity: 'critical' })
    }
    if ((live?.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live?.description ?? '', severity: 'warning' })
    }
    const liveVals = (live?.entries ?? []).map((e) => e.value ?? '').filter(Boolean)
    if (sortedJson(liveVals) !== sortedJson(spec.entries)) {
      diffs.push({ field: `${spec.name}.entries`, expected: [...spec.entries].sort(), actual: [...liveVals].sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

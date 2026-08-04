import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, orgPath, secPolicyDraftPath, basicAuthHeader, getJson } from '../../lib/illumioApi'
import { extractLabelGroupSpecs } from './validate'

type Diffs = DriftResult['diffs']
const LIST_MAX_RESULTS = 10000

interface LiveLabel {
  href?: string
  key?: string
  value?: string
}
interface LiveLabelGroup {
  href?: string
  name?: string
  key?: string
  labels?: Array<{ href?: string }>
}

function labelIdentity(key: string, value: string): string {
  return `${key} ${value}`
}

function normalizeHrefs(hrefs: Array<{ href?: string }> | undefined): string {
  return (hrefs ?? [])
    .map((h) => h.href ?? '')
    .filter(Boolean)
    .sort()
    .join(',')
}

/** See config-types/ip-lists/driftDetect.ts — compares against draft, which this app keeps in lockstep with active via provisioning on every deploy. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  const cred = resolveIllumioCredential(ctx.credential)
  if (!base || !cred) return { hasDrift: false, diffs: [] }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const specs = extractLabelGroupSpecs(ctx.deployedConfig).filter((s) => s.name && s.key && !s.labelsError)
  const diffs: Diffs = []
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let liveLabels: LiveLabel[]
  let live: LiveLabelGroup[]
  try {
    ;[liveLabels, live] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LiveLabelGroup[]>(`${base}${secPolicyDraftPath(settings, 'label_groups')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
    ])
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const labelHrefByIdentity = new Map(
    liveLabels.filter((l) => l.key !== undefined && l.value !== undefined && l.href).map((l) => [labelIdentity(l.key!, l.value!), l.href!]),
  )
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  for (const spec of specs) {
    const l = liveByName.get(spec.name.toLowerCase())
    if (!l) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((l.key ?? '') !== spec.key) {
      diffs.push({ field: `${spec.name}.key`, expected: spec.key, actual: l.key ?? '', severity: 'critical' })
    }

    let wantHrefs: string[]
    try {
      wantHrefs = spec.labels.map((ref) => {
        const href = labelHrefByIdentity.get(labelIdentity(ref.key, ref.value))
        if (!href) throw new Error('unresolved')
        return href
      })
    } catch {
      diffs.push({ field: `${spec.name}.labels`, expected: 'resolved', actual: 'a referenced label no longer exists', severity: 'critical' })
      continue
    }
    const want = [...wantHrefs].sort().join(',')
    const have = normalizeHrefs(l.labels)
    if (want !== have) {
      diffs.push({ field: `${spec.name}.labels`, expected: want, actual: have, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

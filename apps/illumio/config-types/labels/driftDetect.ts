import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, orgPath, basicAuthHeader, getJson } from '../../lib/illumioApi'
import { extractLabelSpecs, labelIdentity, type LiveLabel } from './validate'

type Diffs = DriftResult['diffs']

/** See deploy.ts — same generous cap, same reasoning (unverified PCE default page size). */
const LIST_MAX_RESULTS = 10000

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  const cred = resolveIllumioCredential(ctx.credential)
  // Without a host/credential we can't read live state — assert no drift rather than false-alarm.
  if (!base || !cred) return { hasDrift: false, diffs: [] }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const specs = extractLabelSpecs(ctx.deployedConfig).filter((s) => s.key && s.value)
  const diffs: Diffs = []

  let live: LiveLabel[]
  try {
    live = await getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts)
  } catch {
    // Transport/auth failure — surfaced by healthCheck, not as false drift.
    return { hasDrift: false, diffs: [] }
  }
  const liveByIdentity = new Map<string, LiveLabel>()
  for (const l of live) {
    if (l.key !== undefined && l.value !== undefined) liveByIdentity.set(labelIdentity(l.key, l.value), l)
  }

  for (const spec of specs) {
    const identity = labelIdentity(spec.key, spec.value)
    const l = liveByIdentity.get(identity)
    if (!l) {
      diffs.push({ field: identity, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const liveExternalDataSet = l.external_data_set ?? ''
    const liveExternalDataReference = l.external_data_reference ?? ''
    // Only surface a diff when one side actually declares a value — avoids
    // noise from labels neither side manages via external_data_*.
    if ((spec.externalDataSet || liveExternalDataSet) && spec.externalDataSet !== liveExternalDataSet) {
      diffs.push({
        field: `${identity}.external_data_set`,
        expected: spec.externalDataSet,
        actual: liveExternalDataSet,
        severity: 'warning',
      })
    }
    if ((spec.externalDataReference || liveExternalDataReference) && spec.externalDataReference !== liveExternalDataReference) {
      diffs.push({
        field: `${identity}.external_data_reference`,
        expected: spec.externalDataReference,
        actual: liveExternalDataReference,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

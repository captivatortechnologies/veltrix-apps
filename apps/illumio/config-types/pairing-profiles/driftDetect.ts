import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { readIllumioSettings, resolveIllumioCredential, buildIllumioBaseUrl, orgPath, basicAuthHeader, getJson } from '../../lib/illumioApi'
import { extractPairingProfileSpecs, isUnlimitedOrValidRange } from './validate'

type Diffs = DriftResult['diffs']
const LIST_MAX_RESULTS = 10000

interface LiveLabel {
  href?: string
  key?: string
  value?: string
}
interface LivePairingProfile {
  href?: string
  name?: string
  enabled?: boolean
  enforcement_mode?: string
  allowed_uses_per_key?: number
  key_lifespan?: number
  labels?: Array<{ href?: string }>
  visibility_level?: string
}

function labelIdentity(key: string, value: string): string {
  return `${key} ${value}`
}

function normalizeHrefs(hrefs: Array<{ href?: string }> | undefined): string {
  return (hrefs ?? []).map((h) => h.href ?? '').filter(Boolean).sort().join(',')
}

/** "unlimited" means the PCE field is simply absent — see deploy.ts's toOptionalInt. */
function normalizeLimit(spec: string, live: number | undefined): boolean {
  if (spec === 'unlimited') return live === undefined
  return live === Number(spec)
}

/**
 * Pairing profiles have no draft/active split (see deploy.ts) — compares
 * directly against the live object. Lock flags and log-traffic settings are
 * intentionally not compared here (see README.md Coverage); this focuses on
 * the fields that materially affect VEN onboarding: enabled, enforcement
 * mode, key limits, labels and visibility level.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIllumioSettings(ctx.settings)
  const base = buildIllumioBaseUrl(settings)
  const cred = resolveIllumioCredential(ctx.credential)
  if (!base || !cred) return { hasDrift: false, diffs: [] }

  const headers = basicAuthHeader(cred)
  const opts = { timeoutMs: settings.timeoutMs, verifyTls: settings.verifyTls }
  const specs = extractPairingProfileSpecs(ctx.deployedConfig).filter((s) => s.name && !s.labelsError)
  const diffs: Diffs = []
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let liveLabels: LiveLabel[]
  let live: LivePairingProfile[]
  try {
    ;[liveLabels, live] = await Promise.all([
      getJson<LiveLabel[]>(`${base}${orgPath(settings, 'labels')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
      getJson<LivePairingProfile[]>(`${base}${orgPath(settings, 'pairing_profiles')}?max_results=${LIST_MAX_RESULTS}`, headers, opts),
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
    if ((l.enabled ?? true) !== spec.enabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: spec.enabled, actual: l.enabled ?? true, severity: 'critical' })
    }
    if ((l.enforcement_mode ?? 'visibility_only') !== spec.enforcementMode) {
      diffs.push({ field: `${spec.name}.enforcement_mode`, expected: spec.enforcementMode, actual: l.enforcement_mode ?? 'visibility_only', severity: 'critical' })
    }
    if (isUnlimitedOrValidRange(spec.allowedUsesPerKey) && !normalizeLimit(spec.allowedUsesPerKey, l.allowed_uses_per_key)) {
      diffs.push({ field: `${spec.name}.allowed_uses_per_key`, expected: spec.allowedUsesPerKey, actual: String(l.allowed_uses_per_key ?? 'unlimited'), severity: 'warning' })
    }
    if (isUnlimitedOrValidRange(spec.keyLifespan) && !normalizeLimit(spec.keyLifespan, l.key_lifespan)) {
      diffs.push({ field: `${spec.name}.key_lifespan`, expected: spec.keyLifespan, actual: String(l.key_lifespan ?? 'unlimited'), severity: 'warning' })
    }
    if (spec.visibilityLevel && spec.visibilityLevel !== (l.visibility_level ?? '')) {
      diffs.push({ field: `${spec.name}.visibility_level`, expected: spec.visibilityLevel, actual: l.visibility_level ?? '', severity: 'warning' })
    }

    let wantLabelHrefs: string[]
    try {
      wantLabelHrefs = spec.labels.map((ref) => {
        const href = labelHrefByIdentity.get(labelIdentity(ref.key, ref.value))
        if (!href) throw new Error('unresolved')
        return href
      })
    } catch {
      diffs.push({ field: `${spec.name}.labels`, expected: 'resolved', actual: 'a referenced label no longer exists', severity: 'critical' })
      continue
    }
    const wantLabels = [...wantLabelHrefs].sort().join(',')
    const haveLabels = normalizeHrefs(l.labels)
    if (wantLabels !== haveLabels) {
      diffs.push({ field: `${spec.name}.labels`, expected: wantLabels, actual: haveLabels, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

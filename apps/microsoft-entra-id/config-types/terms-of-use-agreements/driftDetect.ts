import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractTermsOfUseSpecs, type LiveTermsOfUse } from './validate'

const BASE = '/identityGovernance/termsOfUse/agreements'
const SELECT =
  '?$select=id,displayName,isViewingBeforeAcceptanceRequired,isPerDeviceAcceptanceRequired,userReacceptRequiredFrequency,termsExpiration'

type Diffs = DriftResult['diffs']

/** True when two date-time strings represent the same instant (format-tolerant). */
function sameInstant(a: string, b: string): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractTermsOfUseSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveTermsOfUse>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((a) => a.displayName).map((a) => [a.displayName!.toLowerCase(), a])
  )

  const diffs: Diffs = []
  // The PDF file bytes are deliberately NOT compared — only the metadata is.
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const liveViewing = live.isViewingBeforeAcceptanceRequired ?? false
    if (spec.viewingBeforeAcceptanceRequired !== liveViewing) {
      diffs.push({
        field: `${spec.name}.viewingBeforeAcceptanceRequired`,
        expected: spec.viewingBeforeAcceptanceRequired,
        actual: liveViewing,
        severity: 'warning',
      })
    }

    const livePerDevice = live.isPerDeviceAcceptanceRequired ?? false
    if (spec.perDeviceAcceptanceRequired !== livePerDevice) {
      diffs.push({
        field: `${spec.name}.perDeviceAcceptanceRequired`,
        expected: spec.perDeviceAcceptanceRequired,
        actual: livePerDevice,
        severity: 'warning',
      })
    }

    const liveReaccept = (live.userReacceptRequiredFrequency ?? '') as string
    if (spec.reacceptFrequency !== liveReaccept) {
      diffs.push({
        field: `${spec.name}.reacceptFrequency`,
        expected: spec.reacceptFrequency,
        actual: liveReaccept,
        severity: 'warning',
      })
    }

    const liveStart = (live.termsExpiration?.startDateTime ?? '') as string
    if (!sameInstant(spec.expirationStartDate, liveStart)) {
      diffs.push({
        field: `${spec.name}.expirationStartDate`,
        expected: spec.expirationStartDate,
        actual: liveStart,
        severity: 'warning',
      })
    }

    const liveFrequency = (live.termsExpiration?.frequency ?? '') as string
    if (spec.expirationFrequency !== liveFrequency) {
      diffs.push({
        field: `${spec.name}.expirationFrequency`,
        expected: spec.expirationFrequency,
        actual: liveFrequency,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

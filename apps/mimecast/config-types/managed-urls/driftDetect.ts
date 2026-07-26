import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, readMimecastSettings, resolveMimecastCredential } from '../../lib/mimecast'
import { desiredIdentity, extractManagedUrlSpecs, liveIdentity, type LiveManagedUrl } from './validate'
import { definitionEquals } from './deploy'

const GET_ALL = '/api/ttp/url/get-all-managed-urls'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildMimecastClient(cred, settings)

  const specs = extractManagedUrlSpecs(ctx.deployedConfig).filter((s) => s.url)
  const listed = await client.request(GET_ALL, {})
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByKey = new Map<string, LiveManagedUrl>()
  for (const e of listed.data as LiveManagedUrl[]) liveByKey.set(liveIdentity(e), e)

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByKey.get(desiredIdentity(spec))
    if (!live) {
      diffs.push({ field: spec.url, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!definitionEquals(live, spec)) {
      if ((live.action ?? '') !== spec.action) {
        diffs.push({ field: `${spec.url}.action`, expected: spec.action, actual: live.action ?? '', severity: 'warning' })
      }
      if ((live.comment ?? '') !== spec.comment) {
        diffs.push({ field: `${spec.url}.comment`, expected: spec.comment, actual: live.comment ?? '', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractSourceAppSpecs, type LiveSourceApp } from './validate'

const BASE = '/beta/source-apps'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractSourceAppSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveSourceApp>(`${BASE}/all`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((a) => a.name).map((a) => [a.name!.toLowerCase(), a]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.matchAllAccounts ?? false) !== spec.matchAllAccounts) {
      diffs.push({ field: `${spec.name}.matchAllAccounts`, expected: String(spec.matchAllAccounts), actual: String(live.matchAllAccounts ?? false), severity: 'warning' })
    }
    if ((live.accountSource?.id ?? '') !== spec.accountSourceId) {
      diffs.push({ field: `${spec.name}.accountSource`, expected: spec.accountSourceId, actual: live.accountSource?.id ?? '', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

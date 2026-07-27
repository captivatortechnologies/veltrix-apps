import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDuoClient, readDuoSettings, resolveDuoCredential } from '../../lib/duo'
import { extractAdminSpecs, type LiveAdmin } from './validate'

const BASE = '/admin/v1/admins'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildDuoClient(cred, settings)

  const specs = extractAdminSpecs(ctx.deployedConfig).filter((s) => s.email)
  const listed = await client.getAll<LiveAdmin>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByEmail = new Map(listed.items.filter((a) => a.email).map((a) => [a.email!.toLowerCase(), a]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByEmail.get(spec.email)
    if (!live) {
      diffs.push({ field: spec.email, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.name ?? '') !== spec.name) {
      diffs.push({ field: `${spec.email}.name`, expected: spec.name, actual: live.name ?? '', severity: 'warning' })
    }
    if ((live.role ?? '') !== spec.role) {
      diffs.push({ field: `${spec.email}.role`, expected: spec.role, actual: live.role ?? '', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

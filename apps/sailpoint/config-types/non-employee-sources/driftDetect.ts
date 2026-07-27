import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import { extractNonEmployeeSourceSpecs, type LiveNonEmployeeSource } from './validate'

const BASE = '/beta/non-employee-sources'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractNonEmployeeSourceSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveNonEmployeeSource>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

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
    if (((live.managementWorkgroup ?? '') as string) !== spec.managementWorkgroup) {
      diffs.push({ field: `${spec.name}.managementWorkgroup`, expected: spec.managementWorkgroup, actual: live.managementWorkgroup ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

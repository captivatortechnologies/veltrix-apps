import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import type { LiveRole } from '../roles/validate'
import { extractDimensionSpecs, type LiveDimension } from './validate'

const ROLES = '/v3/roles'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildIscClient(cred, settings)

  const specs = extractDimensionSpecs(ctx.deployedConfig).filter((s) => s.name && s.roleName)
  const rolesRes = await client.getAll<LiveRole>(ROLES)
  if (!rolesRes.ok) return { hasDrift: false, diffs: [] }
  const roleByName = new Map(rolesRes.items.filter((r) => r.name && r.id).map((r) => [r.name!.toLowerCase(), r]))

  const childCache = new Map<string, Map<string, LiveDimension>>()
  const diffs: Diffs = []
  for (const spec of specs) {
    const role = roleByName.get(spec.roleName.toLowerCase())
    if (!role?.id) {
      diffs.push({ field: `${spec.roleName}/${spec.name}`, expected: 'present', actual: 'role absent', severity: 'critical' })
      continue
    }
    let children = childCache.get(role.id)
    if (!children) {
      const listed = await client.getAll<LiveDimension>(`/beta/roles/${role.id}/dimensions`)
      children = new Map(listed.items.filter((d) => d.name).map((d) => [d.name!.toLowerCase(), d]))
      childCache.set(role.id, children)
    }
    const live = children.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: `${spec.roleName}/${spec.name}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((live.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.roleName}/${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.owner?.id ?? '') !== spec.ownerId) {
      diffs.push({ field: `${spec.roleName}/${spec.name}.owner`, expected: spec.ownerId, actual: live.owner?.id ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

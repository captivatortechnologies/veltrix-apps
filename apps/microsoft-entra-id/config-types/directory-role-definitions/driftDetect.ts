import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { actionsEqual, extractRoleDefinitionSpecs, liveActions, type LiveRoleDefinition } from './validate'

const BASE = '/roleManagement/directory/roleDefinitions'
const SELECT = '?$select=id,displayName,description,isBuiltIn,isEnabled,rolePermissions'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractRoleDefinitionSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveRoleDefinition>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((r) => r.displayName).map((r) => [r.displayName!.toLowerCase(), r])
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const wantDescription = spec.description || ''
    const liveDescription = (live.description ?? '') as string
    if (liveDescription !== wantDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: wantDescription,
        actual: liveDescription,
        severity: 'warning',
      })
    }
    const liveEnabled = live.isEnabled !== false
    if (spec.isEnabled !== liveEnabled) {
      diffs.push({
        field: `${spec.name}.isEnabled`,
        expected: String(spec.isEnabled),
        actual: String(liveEnabled),
        severity: 'warning',
      })
    }
    const live_actions = liveActions(live)
    if (!actionsEqual(spec.actions, live_actions)) {
      diffs.push({
        field: `${spec.name}.allowedResourceActions`,
        expected: spec.actions.join(', '),
        actual: live_actions.join(', '),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

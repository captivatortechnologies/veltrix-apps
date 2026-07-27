import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  extractRoleDefinitionSpecs,
  isCustomRole,
  liveActions,
  type RoleDefinitionSpec,
  type LiveRoleDefinition,
} from './validate'

const BASE = '/roleManagement/directory/roleDefinitions'
const SELECT = '?$select=id,displayName,description,isBuiltIn,isEnabled,rolePermissions'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

/** Body for POST / PATCH — a single rolePermissions entry holding the actions. */
export function buildBody(spec: RoleDefinitionSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || null,
    isEnabled: spec.isEnabled,
    rolePermissions: [{ allowedResourceActions: spec.actions }],
  }
}

function snapshotLive(live: LiveRoleDefinition): Record<string, unknown> {
  return {
    displayName: live.displayName,
    description: live.description ?? null,
    isEnabled: live.isEnabled ?? true,
    rolePermissions: [{ allowedResourceActions: liveActions(live) }],
  }
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractRoleDefinitionSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveRoleDefinition>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list role definitions: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveRoleDefinition>()
  const liveById = new Map<string, LiveRoleDefinition>()
  for (const r of listed.items) {
    if (r.displayName) liveByName.set(r.displayName.toLowerCase(), r)
    if (r.id) liveById.set(r.id, r)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      // Never modify a built-in directory role — only custom roles are manageable.
      if (!isCustomRole(liveMatch)) {
        failures.push(`${spec.name}: a built-in directory role with this name exists and will not be modified`)
        continue
      }
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, buildBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveRoleDefinition>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete role definitions THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some role definitions failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} role definition(s)`,
    rollbackData: { entries },
  }
}

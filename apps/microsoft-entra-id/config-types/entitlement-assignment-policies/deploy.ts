import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractAssignmentPolicySpecs, parseObject, type AssignmentPolicySpec, type LiveAssignmentPolicy } from './validate'

const BASE = '/identityGovernance/entitlementManagement/assignmentPolicies'
const SELECT = '?$select=id,displayName,description,allowedTargetScope,expiration,requestorSettings,requestApprovalSettings'
const PACKAGES = '/identityGovernance/entitlementManagement/accessPackages?$select=id,displayName'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

interface LivePackage {
  id?: string
  displayName?: string
}

export function buildPatchBody(spec: AssignmentPolicySpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    description: spec.description || '',
    allowedTargetScope: spec.allowedTargetScope,
    expiration: parseObject(spec.expiration) ?? {},
    requestorSettings: parseObject(spec.requestorSettings) ?? {},
    requestApprovalSettings: parseObject(spec.requestApprovalSettings) ?? {},
  }
}

export function buildCreateBody(spec: AssignmentPolicySpec, accessPackageId: string): Record<string, unknown> {
  return { ...buildPatchBody(spec), accessPackage: { id: accessPackageId } }
}

function snapshotLive(live: LiveAssignmentPolicy): Record<string, unknown> {
  return {
    displayName: live.displayName,
    description: live.description ?? '',
    allowedTargetScope: live.allowedTargetScope ?? 'notSpecified',
    expiration: live.expiration ?? {},
    requestorSettings: live.requestorSettings ?? {},
    requestApprovalSettings: live.requestApprovalSettings ?? {},
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

  const specs = extractAssignmentPolicySpecs(ctx.canvas).filter((s) => s.name && s.accessPackageName)

  const packagesRes = await client.getAll<LivePackage>(PACKAGES)
  if (!packagesRes.ok) {
    return { success: false, message: `Failed to list access packages: ${graphErrorMessage(packagesRes.lastError!)}` }
  }
  const packageByName = new Map<string, string>()
  for (const p of packagesRes.items) {
    if (p.displayName && p.id) packageByName.set(p.displayName.toLowerCase(), p.id)
  }

  const listed = await client.getAll<LiveAssignmentPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list assignment policies: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveAssignmentPolicy>()
  const liveById = new Map<string, LiveAssignmentPolicy>()
  for (const p of listed.items) {
    if (p.displayName) liveByName.set(p.displayName.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const packageId = packageByName.get(spec.accessPackageName.toLowerCase())
    if (!packageId) {
      failures.push(`${spec.name}: access package "${spec.accessPackageName}" not found`)
      continue
    }
    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec, packageId))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveAssignmentPolicy>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some assignment policies failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} assignment policy(ies)`, rollbackData: { entries } }
}

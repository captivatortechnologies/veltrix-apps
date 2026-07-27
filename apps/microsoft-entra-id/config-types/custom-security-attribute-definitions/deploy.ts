import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  definitionId,
  extractAttributeDefinitionSpecs,
  type AttributeDefinitionSpec,
  type LiveAttributeDefinition,
} from './validate'

const BASE = '/directory/customSecurityAttributeDefinitions'
const SELECT =
  '?$select=id,attributeSet,name,type,status,isCollection,isSearchable,usePreDefinedValuesOnly,description'

export interface RollbackEntry {
  itemId?: string
  /** The composite definition id (attributeSet_name). */
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

/** POST body — includes the immutable fields set only at creation. */
export function buildCreateBody(spec: AttributeDefinitionSpec): Record<string, unknown> {
  return {
    attributeSet: spec.attributeSet,
    name: spec.name,
    type: spec.type,
    status: spec.status,
    isCollection: spec.isCollection,
    isSearchable: spec.isSearchable,
    usePreDefinedValuesOnly: spec.usePreDefinedValuesOnly,
    description: spec.description || '',
  }
}

/** PATCH body — only the mutable fields. */
export function buildPatchBody(spec: AttributeDefinitionSpec): Record<string, unknown> {
  return {
    status: spec.status,
    usePreDefinedValuesOnly: spec.usePreDefinedValuesOnly,
    description: spec.description || '',
  }
}

function snapshotLive(live: LiveAttributeDefinition): Record<string, unknown> {
  return {
    status: live.status ?? 'Available',
    usePreDefinedValuesOnly: live.usePreDefinedValuesOnly ?? false,
    description: live.description ?? '',
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

  const specs = extractAttributeDefinitionSpecs(ctx.canvas).filter((s) => s.attributeSet && s.name)

  const listed = await client.getAll<LiveAttributeDefinition>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list attribute definitions: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveById = new Map<string, LiveAttributeDefinition>()
  for (const d of listed.items) {
    if (d.id) liveById.set(d.id.toLowerCase(), d)
  }

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const id = definitionId(spec)
    const live = liveById.get(id.toLowerCase()) ?? null

    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${id}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: id, existed: true, id: live.id, prior: snapshotLive(live) })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${id}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: id, existed: false, id })
    }
  }

  // Reconcile: definitions cannot be deleted — deactivate (status Deprecated)
  // any this app created previously but no longer declares.
  const declared = new Set(specs.map((s) => definitionId(s).toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id?.toLowerCase()).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id.toLowerCase()) && !declared.has(p.name.toLowerCase())) {
      const resp = await client.patch(`${BASE}/${p.id}`, { status: 'Deprecated' })
      if (!resp.ok && resp.status !== 404) {
        failures.push(`deprecate ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some attribute definitions failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} attribute definition(s)`,
    rollbackData: { entries },
  }
}

import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { LiveSource } from '../sources/validate'
import {
  extractSourceSchemaSpecs,
  parseJsonArray,
  parseJsonObject,
  type LiveSourceSchema,
  type SourceSchemaSpec,
} from './validate'

const SOURCES = '/v3/sources'
const childPath = (sourceId: string): string => `${SOURCES}/${sourceId}/schemas`

export interface RollbackEntry {
  itemId?: string
  sourceName: string
  sourceId: string
  schemaName: string
  existed: boolean
  schemaId?: string
  prior?: Record<string, unknown>
}

function buildBody(spec: SourceSchemaSpec, attributes: unknown[], configuration: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    nativeObjectType: spec.nativeObjectType,
    identityAttribute: spec.identityAttribute,
    displayAttribute: spec.displayAttribute,
    includePermissions: spec.includePermissions,
    attributes,
    configuration,
  }
  if (spec.hierarchyAttribute) body.hierarchyAttribute = spec.hierarchyAttribute
  return body
}

function snapshot(live: LiveSourceSchema): Record<string, unknown> {
  return {
    name: live.name,
    nativeObjectType: live.nativeObjectType ?? '',
    identityAttribute: live.identityAttribute ?? '',
    displayAttribute: live.displayAttribute ?? '',
    includePermissions: live.includePermissions ?? false,
    attributes: live.attributes ?? [],
    configuration: live.configuration ?? {},
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
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const specs = extractSourceSchemaSpecs(ctx.canvas).filter((s) => s.name && s.sourceName)

  const sourcesRes = await client.getAll<LiveSource>(SOURCES)
  if (!sourcesRes.ok) return { success: false, message: `Failed to list sources: ${iscErrorMessage(sourcesRes.lastError!)}` }
  const sourceByName = new Map(sourcesRes.items.filter((s) => s.name && s.id).map((s) => [s.name!.toLowerCase(), s]))

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  const bySource = new Map<string, SourceSchemaSpec[]>()
  for (const spec of specs) {
    const key = spec.sourceName.toLowerCase()
    const list = bySource.get(key) ?? []
    list.push(spec)
    bySource.set(key, list)
  }

  for (const [sourceKey, group] of bySource) {
    const source = sourceByName.get(sourceKey)
    if (!source?.id) {
      for (const s of group) failures.push(`${s.name}: source "${s.sourceName}" not found`)
      continue
    }
    const listed = await client.getAll<LiveSourceSchema>(childPath(source.id))
    if (!listed.ok) {
      failures.push(`source "${group[0].sourceName}": failed to list schemas: ${iscErrorMessage(listed.lastError!)}`)
      continue
    }
    const liveByName = new Map(listed.items.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

    for (const spec of group) {
      const attrs = parseJsonArray(spec.attributesRaw)
      const cfg = parseJsonObject(spec.configurationRaw)
      if (!attrs.ok || !cfg.ok) {
        failures.push(`${spec.name}: ${!attrs.ok ? attrs.error : (cfg as { error: string }).error}`)
        continue
      }
      const body = buildBody(spec, attrs.value, cfg.value)
      const live = liveByName.get(spec.name.toLowerCase()) ?? null
      if (live?.id) {
        const resp = await client.put(`${childPath(source.id)}/${live.id}`, body)
        if (!resp.ok) {
          failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, sourceName: spec.sourceName, sourceId: source.id, schemaName: spec.name, existed: true, schemaId: live.id, prior: snapshot(live) })
      } else {
        const resp = await client.post(childPath(source.id), body)
        if (!resp.ok) {
          failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
          continue
        }
        const created = parseJson<LiveSourceSchema>(resp.body)
        entries.push({ itemId: spec.itemId, sourceName: spec.sourceName, sourceId: source.id, schemaName: spec.name, existed: false, schemaId: created?.id })
      }
    }
  }

  // Reconcile: delete schemas THIS app created but no longer declares.
  const declared = new Set(specs.map((s) => `${s.sourceName.toLowerCase()}::${s.name.toLowerCase()}`))
  const keptIds = new Set(entries.map((e) => e.schemaId).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.schemaId && !keptIds.has(p.schemaId) && !declared.has(`${p.sourceName.toLowerCase()}::${p.schemaName.toLowerCase()}`)) {
      const resp = await client.delete(`${childPath(p.sourceId)}/${p.schemaId}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.schemaName}: ${iscErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some source schemas failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} source schema(s)`, rollbackData: { entries } }
}

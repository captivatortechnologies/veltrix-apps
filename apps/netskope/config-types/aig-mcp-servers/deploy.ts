import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractNpaObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { extractMcpServerSpecs, liveMcpServerId, type LiveMcpServer, type McpServerSpec } from './validate'

const BASE = '/aig/mcpservers'

/** Rollback snapshot — the certificate is write-only and cannot be restored. */
export interface McpServerSnapshot {
  name: string
  host: string
  port: number
  path: string
  protocol: string
  schema: string
  tools: string[]
  resources: string[]
  prompts: string[]
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: McpServerSnapshot
}

export function mcpServerBody(spec: McpServerSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    host: spec.host,
    port: spec.port,
    path: spec.path,
    protocol: spec.protocol,
    tools: spec.tools,
    resources: spec.resources,
    prompts: spec.prompts,
  }
  if (spec.schema) body.schema = spec.schema
  if (spec.certificate) body.certificate = spec.certificate
  return body
}

function snapshotLive(live: LiveMcpServer): McpServerSnapshot {
  return {
    name: live.name ?? '',
    host: live.host ?? '',
    port: live.port ?? 0,
    path: live.path ?? '',
    protocol: live.protocol ?? '',
    schema: live.schema ?? '',
    tools: live.tools ?? [],
    resources: live.resources ?? [],
    prompts: live.prompts ?? [],
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
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractMcpServerSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveMcpServer>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list MCP servers: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveMcpServer>()
  const liveById = new Map<string, LiveMcpServer>()
  for (const s of listed.items) {
    if (s.name) liveByName.set(s.name.toLowerCase(), s)
    const id = liveMcpServerId(s)
    if (id) liveById.set(id, s)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveMcpServerId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, mcpServerBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, mcpServerBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractNpaObject<LiveMcpServer>(resp.body)
      const newId = created ? liveMcpServerId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete MCP servers THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some MCP servers failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} MCP server(s)`, rollbackData: { entries } }
}

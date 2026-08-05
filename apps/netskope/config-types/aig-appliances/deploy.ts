import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractProfileObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { liveAiProviderId, type LiveAiProvider } from '../aig-ai-providers/validate'
import { liveMcpServerId, type LiveMcpServer } from '../aig-mcp-servers/validate'
import { extractAigApplianceSpecs, liveAigApplianceId, type AigApplianceSpec, type LiveAigAppliance } from './validate'

const BASE = '/aig/appliances'
const AI_PROVIDERS_BASE = '/aig/aiproviders'
const MCP_SERVERS_BASE = '/aig/mcpservers'

export interface AigApplianceSnapshot {
  name: string
  host: string
  ports: { http: { enable: boolean; port: number }; https: { enable: boolean; port: number } }
  ai_provider_ids: string[]
  mcp_server_ids: string[]
  sku_addons: Array<{ product_code: string; quantity?: number }>
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: AigApplianceSnapshot
}

export function aigApplianceBody(spec: AigApplianceSpec, aiProviderIds: string[], mcpServerIds: string[]): Record<string, unknown> {
  return {
    name: spec.name,
    host: spec.host,
    ports: {
      http: { enable: spec.httpEnable, port: spec.httpPort },
      https: { enable: spec.httpsEnable, port: spec.httpsPort },
    },
    ai_provider_ids: aiProviderIds,
    mcp_server_ids: mcpServerIds,
    sku_addons: spec.skuAddons.map((a) => ({ product_code: a.productCode, ...(a.quantity !== undefined ? { quantity: a.quantity } : {}) })),
  }
}

function snapshotLive(live: LiveAigAppliance): AigApplianceSnapshot {
  return {
    name: live.name ?? '',
    host: live.host ?? '',
    ports: {
      http: { enable: live.ports?.http?.enable === true, port: live.ports?.http?.port ?? 80 },
      https: { enable: live.ports?.https?.enable === true, port: live.ports?.https?.port ?? 443 },
    },
    ai_provider_ids: live.ai_provider_ids ?? [],
    mcp_server_ids: live.mcp_server_ids ?? [],
    sku_addons: (live.sku_addons ?? []).map((a) => ({ product_code: a.product_code ?? '', quantity: a.quantity })),
  }
}

/** Resolve declared names/ids against a live name->id map and a set of known ids. */
function resolveRefs(entries: string[], byName: Map<string, string>, byId: Set<string>): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = []
  const unresolved: string[] = []
  for (const entry of entries) {
    const id = byId.has(entry) ? entry : byName.get(entry.toLowerCase())
    if (id) resolved.push(id)
    else unresolved.push(entry)
  }
  return { resolved, unresolved }
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

  const specs = extractAigApplianceSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveAigAppliance>(BASE)
  if (!listed.ok) return { success: false, message: `Failed to list AI Gateway appliances: ${netskopeErrorMessage(listed.lastError!)}` }
  const liveByName = new Map<string, LiveAigAppliance>()
  const liveById = new Map<string, LiveAigAppliance>()
  for (const a of listed.items) {
    if (a.name) liveByName.set(a.name.toLowerCase(), a)
    const id = liveAigApplianceId(a)
    if (id) liveById.set(id, a)
  }

  const providers = await client.getAll<LiveAiProvider>(AI_PROVIDERS_BASE)
  if (!providers.ok) return { success: false, message: `Failed to list AI providers: ${netskopeErrorMessage(providers.lastError!)}` }
  const providerByName = new Map<string, string>()
  const providerIds = new Set<string>()
  for (const p of providers.items) {
    const id = liveAiProviderId(p)
    if (!id) continue
    providerIds.add(id)
    if (p.name) providerByName.set(p.name.toLowerCase(), id)
  }

  const mcpServers = await client.getAll<LiveMcpServer>(MCP_SERVERS_BASE)
  if (!mcpServers.ok) return { success: false, message: `Failed to list MCP servers: ${netskopeErrorMessage(mcpServers.lastError!)}` }
  const mcpByName = new Map<string, string>()
  const mcpIds = new Set<string>()
  for (const m of mcpServers.items) {
    const id = liveMcpServerId(m)
    if (!id) continue
    mcpIds.add(id)
    if (m.name) mcpByName.set(m.name.toLowerCase(), id)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const aiProviderRefs = resolveRefs(spec.aiProviders, providerByName, providerIds)
    const mcpServerRefs = resolveRefs(spec.mcpServers, mcpByName, mcpIds)
    const unresolved = [...aiProviderRefs.unresolved, ...mcpServerRefs.unresolved]
    if (unresolved.length) {
      failures.push(`${spec.name}: unknown AI provider / MCP server: ${unresolved.join(', ')}`)
      continue
    }

    const body = aigApplianceBody(spec, aiProviderRefs.resolved, mcpServerRefs.resolved)

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveAigApplianceId(live) : undefined

    if (liveId) {
      const resp = await client.patch(`${BASE}/${liveId}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      // The create response also carries a one-time JWT enrollment token —
      // deliberately never read here (see validate.ts header comment).
      const created = extractProfileObject<LiveAigAppliance>(resp.body)
      const newId = created ? liveAigApplianceId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete appliances THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some AI Gateway appliances failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} AI Gateway appliance(s)`, rollbackData: { entries } }
}

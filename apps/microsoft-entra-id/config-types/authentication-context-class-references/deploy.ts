import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  extractAuthContextSpecs,
  type AuthContextSpec,
  type LiveAuthContext,
} from './validate'

const BASE = '/identity/conditionalAccess/authenticationContextClassReferences'

export interface RollbackEntry {
  itemId?: string
  /** The context id (c1..c25) — the identity and the Graph resource id. */
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

/** Body for the PATCH upsert of /{id}. */
export function buildBody(spec: AuthContextSpec): Record<string, unknown> {
  return {
    displayName: spec.displayName,
    description: spec.description || '',
    isAvailable: spec.isAvailable,
  }
}

function snapshotLive(live: LiveAuthContext): Record<string, unknown> {
  return {
    displayName: live.displayName,
    description: live.description ?? '',
    isAvailable: live.isAvailable ?? false,
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

  const specs = extractAuthContextSpecs(ctx.canvas).filter((s) => s.contextId)

  const listed = await client.getAll<LiveAuthContext>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list authentication contexts: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveById = new Map<string, LiveAuthContext>()
  for (const c of listed.items) {
    if (c.id) liveById.set(c.id, c)
  }

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const live = liveById.get(spec.contextId) ?? null
    // Create-or-update is a single PATCH upsert keyed by the context id.
    const resp = await client.patch(`${BASE}/${spec.contextId}`, buildBody(spec))
    if (!resp.ok) {
      failures.push(`${spec.contextId}: ${graphErrorMessage(resp)}`)
      continue
    }
    entries.push({
      itemId: spec.itemId,
      name: spec.contextId,
      existed: Boolean(live),
      id: spec.contextId,
      prior: live ? snapshotLive(live) : undefined,
    })
  }

  // Reconcile: delete contexts THIS app created previously but no longer declares.
  const declaredIds = new Set(specs.map((s) => s.contextId))
  for (const p of prior) {
    if (!p.existed && p.id && !declaredIds.has(p.id)) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some authentication contexts failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} authentication context(s)`,
    rollbackData: { entries },
  }
}

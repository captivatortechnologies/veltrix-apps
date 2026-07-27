import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  extractCrossTenantPartnerSpecs,
  parseObject,
  type LiveCrossTenantPartner,
} from './validate'

const BASE = '/policies/crossTenantAccessPolicy/partners'

export interface RollbackEntry {
  itemId?: string
  /** The partner tenantId — identity and resource key. */
  name: string
  existed: boolean
  id?: string
  /** Prior values of the declared setting keys, captured before an update. */
  prior?: Record<string, unknown>
}

/** Capture the live values of just the keys this deploy will set, for rollback. */
function snapshotLive(live: LiveCrossTenantPartner, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = live[k] ?? null
  return out
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

  const specs = extractCrossTenantPartnerSpecs(ctx.canvas).filter((s) => s.tenantId)

  const listed = await client.getAll<LiveCrossTenantPartner>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list cross-tenant partners: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByTenant = new Map<string, LiveCrossTenantPartner>()
  for (const p of listed.items) {
    if (p.tenantId) liveByTenant.set(p.tenantId.toLowerCase(), p)
  }

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const config = parseObject(spec.configuration) ?? {}
    const keys = Object.keys(config)
    const live = liveByTenant.get(spec.tenantId) ?? null

    if (!live) {
      const created = await client.post(BASE, { tenantId: spec.tenantId })
      if (!created.ok) {
        failures.push(`${spec.tenantId}: ${graphErrorMessage(created)}`)
        continue
      }
      if (keys.length) {
        const patched = await client.patch(`${BASE}/${spec.tenantId}`, config)
        if (!patched.ok) {
          failures.push(`${spec.tenantId}: ${graphErrorMessage(patched)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.tenantId, existed: false, id: spec.tenantId })
    } else {
      if (keys.length) {
        const patched = await client.patch(`${BASE}/${spec.tenantId}`, config)
        if (!patched.ok) {
          failures.push(`${spec.tenantId}: ${graphErrorMessage(patched)}`)
          continue
        }
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.tenantId,
        existed: true,
        id: spec.tenantId,
        prior: snapshotLive(live, keys),
      })
    }
  }

  // Reconcile: delete partners THIS app created previously but no longer declares.
  const declared = new Set(specs.map((s) => s.tenantId))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declared.has(p.id)) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some cross-tenant partners failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} cross-tenant partner(s)`,
    rollbackData: { entries },
  }
}

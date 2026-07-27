import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { extractAttributeSetSpecs, type AttributeSetSpec, type LiveAttributeSet } from './validate'

const BASE = '/directory/attributeSets'
const SELECT = '?$select=id,description,maxAttributesPerSet'

export interface RollbackEntry {
  itemId?: string
  /** The attribute set id — the logical identity. */
  name: string
  existed: boolean
  id?: string
  prior?: Record<string, unknown>
}

/** POST body includes the (immutable) id; PATCH body carries only mutable fields. */
export function buildCreateBody(spec: AttributeSetSpec): Record<string, unknown> {
  return { id: spec.id, description: spec.description || '', maxAttributesPerSet: spec.maxAttributesPerSet }
}

export function buildPatchBody(spec: AttributeSetSpec): Record<string, unknown> {
  return { description: spec.description || '', maxAttributesPerSet: spec.maxAttributesPerSet }
}

function snapshotLive(live: LiveAttributeSet): Record<string, unknown> {
  return { description: live.description ?? '', maxAttributesPerSet: live.maxAttributesPerSet ?? null }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractAttributeSetSpecs(ctx.canvas).filter((s) => s.id)

  const listed = await client.getAll<LiveAttributeSet>(`${BASE}${SELECT}`)
  if (!listed.ok) {
    return { success: false, message: `Failed to list attribute sets: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveById = new Map<string, LiveAttributeSet>()
  for (const s of listed.items) {
    if (s.id) liveById.set(s.id.toLowerCase(), s)
  }

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const live = liveById.get(spec.id.toLowerCase()) ?? null
    if (live?.id) {
      const resp = await client.patch(`${BASE}/${live.id}`, buildPatchBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.id}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.id, existed: true, id: live.id, prior: snapshotLive(live) })
    } else {
      const resp = await client.post(BASE, buildCreateBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.id}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.id, existed: false, id: spec.id })
    }
  }

  // Attribute sets cannot be deleted — no reconcile-delete. Sets this app created
  // and no longer declares are left in place (preserve, never delete).

  if (failures.length) {
    return {
      success: false,
      message: `Some attribute sets failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} attribute set(s)`,
    rollbackData: { entries },
  }
}

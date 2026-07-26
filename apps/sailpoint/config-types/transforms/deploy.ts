import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import {
  extractTransformSpecs,
  parseAttributes,
  type LiveTransform,
  type TransformSpec,
} from './validate'

const BASE = '/transforms/v1'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the transform existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** Prior body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/** Body for POST / PUT /transforms/v1. */
export function buildTransformBody(
  spec: TransformSpec,
  attributes: Record<string, unknown>
): Record<string, unknown> {
  return { name: spec.name, type: spec.type, attributes }
}

function snapshotLive(live: LiveTransform): Record<string, unknown> {
  return { name: live.name, type: live.type, attributes: live.attributes ?? {} }
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

  const specs = extractTransformSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveTransform>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list transforms: ${iscErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveTransform>()
  for (const t of listed.items) {
    if (t.name) liveByName.set(t.name.toLowerCase(), t)
  }

  const prior = await loadPriorEntries(ctx)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const parsed = parseAttributes(spec.attributesRaw)
    if (!parsed.ok) {
      failures.push(`${spec.name}: ${parsed.error}`)
      continue
    }
    const body = buildTransformBody(spec, parsed.value)
    const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      // Never modify a SailPoint-internal transform.
      if (liveMatch.internal) {
        failures.push(`${spec.name}: a built-in (internal) transform with this name exists and will not be modified`)
        continue
      }
      // type is immutable — a same-name, different-type transform must be
      // removed/renamed by an operator, not silently replaced.
      if (liveMatch.type && spec.type && liveMatch.type !== spec.type) {
        failures.push(
          `${spec.name}: a transform with this name already exists with type "${liveMatch.type}" — ` +
            `type is immutable, so rename this one or delete the existing transform first`
        )
        continue
      }
      const resp = await client.put(`${BASE}/${liveMatch.id}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveTransform>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete transforms THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      // 404 = already gone; 400 is often "in use by an Identity Profile mapping".
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${iscErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some transforms failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} transform(s)`,
    rollbackData: { entries },
  }
}

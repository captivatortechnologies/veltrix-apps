import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type QRadarClient,
} from '../../lib/qradar'
import { extractClosingReasonSpecs, type LiveClosingReason } from './validate'

const PATH = '/siem/offense_closing_reasons'
const enc = encodeURIComponent

export interface RollbackEntry {
  itemId?: string
  text: string
  existed: boolean
  id?: number
}

export async function listClosingReasons(client: QRadarClient): Promise<LiveClosingReason[]> {
  const res = await client.request('GET', PATH, { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveClosingReason[]>(res.body)
  return Array.isArray(parsed) ? parsed.filter((r) => !r.is_deleted) : []
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
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractClosingReasonSpecs(ctx.canvas).filter((s) => s.text)
  await loadPriorEntries(ctx)

  const live = await listClosingReasons(client)
  const byText = new Map(live.filter((r) => r.text).map((r) => [String(r.text).toLowerCase(), r]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  let created = 0

  for (const spec of specs) {
    const existing = byText.get(spec.text.toLowerCase())
    if (existing) {
      entries.push({ itemId: spec.itemId, text: spec.text, existed: true, id: typeof existing.id === 'number' ? existing.id : undefined })
      continue
    }
    // Create-only: the reason text is passed as a query parameter (no JSON body).
    const resp = await client.request('POST', `${PATH}?reason=${enc(spec.text)}`)
    if (!resp.ok) {
      failures.push(`${spec.text}: ${qradarErrorMessage(resp)}`)
      continue
    }
    const made = parseJson<LiveClosingReason>(resp.body)
    created++
    entries.push({ itemId: spec.itemId, text: spec.text, existed: false, id: made?.id })
  }

  // NOTE: the API exposes no update or delete for closing reasons, so there is no
  // reconcile-delete — reasons this app created but no longer declares remain.

  if (failures.length) {
    return { success: false, message: `Some closing reasons failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Ensured ${entries.length} closing reason(s) (${created} created)`, rollbackData: { entries } }
}

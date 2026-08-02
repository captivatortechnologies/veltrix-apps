import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, getJson, groupResourcePath } from '../../lib/criblApi'
import { canonicalJson, findPipeline, parseConf, pipelinesFromList, resolveWorkerGroup, type CriblPipeline } from './_shared'

/**
 * Drift for pipelines: compare the Function chain we declare against the live
 * pipeline in Cribl (read-only GET /api/v1/m/<group>/pipelines). A pipeline we
 * declare but that is missing in Cribl is critical drift; a differing Function
 * chain is a warning. Best-effort — a group we can't read raises no false drift.
 * Verify against a live Cribl.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  let headers: Record<string, string>
  try {
    headers = await criblConnect(base, credential)
  } catch {
    return { hasDrift: false, diffs } // can't authenticate → assert no drift
  }

  const liveByGroup = new Map<string, CriblPipeline[] | null>()
  const loadGroup = async (group: string): Promise<CriblPipeline[] | null> => {
    if (liveByGroup.has(group)) return liveByGroup.get(group)!
    let live: CriblPipeline[] | null
    try {
      live = pipelinesFromList(await getJson<unknown>(groupResourcePath(base, group, 'pipelines'), headers))
    } catch {
      live = null // best-effort: can't read this group, skip its items
    }
    liveByGroup.set(group, live)
    return live
  }

  for (const item of items) {
    const id = String(item.fields.id ?? '').trim()
    if (!id) continue

    const group = resolveWorkerGroup(item.fields, settings ?? {})
    const live = await loadGroup(group)
    if (live === null) continue

    const label = group ? `${group}/${id}` : id
    const match = findPipeline(live, id)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const { conf } = parseConf(item.fields.conf)
    if (!conf) continue
    const expected = canonicalJson(conf.functions)
    const actual = canonicalJson(match.conf?.functions ?? [])
    if (expected !== actual) {
      diffs.push({ field: `${label}.functions`, expected: conf.functions, actual: match.conf?.functions ?? [], severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

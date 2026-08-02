import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, getJson, groupResourcePath } from '../../lib/criblApi'
import { itemsFromList, findById, canonicalJson, resolveWorkerGroup } from '../../lib/criblCommon'
import { parseRoutes, ROUTES_TABLE_DEFAULT_ID, type CriblRoutingTable } from './_shared'

/**
 * Drift for the routing table: compare the ordered Route list we declare against
 * the live table in Cribl (read-only GET /api/v1/m/<group>/routes). Route ORDER
 * is significant, so the comparison is order-sensitive (canonicalJson preserves
 * array order while ignoring object-key order). A table we declare but that is
 * missing is critical drift; a differing Route list is a warning. Best-effort —
 * a group we can't read raises no false drift. Verify against a live Cribl.
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
    return { hasDrift: false, diffs }
  }

  const liveByGroup = new Map<string, CriblRoutingTable[] | null>()
  const loadGroup = async (group: string): Promise<CriblRoutingTable[] | null> => {
    if (liveByGroup.has(group)) return liveByGroup.get(group)!
    let live: CriblRoutingTable[] | null
    try {
      live = itemsFromList<CriblRoutingTable>(await getJson<unknown>(groupResourcePath(base, group, 'routes'), headers))
    } catch {
      live = null
    }
    liveByGroup.set(group, live)
    return live
  }

  for (const item of items) {
    const id = String(item.fields.id ?? '').trim() || ROUTES_TABLE_DEFAULT_ID
    const group = resolveWorkerGroup(item.fields, settings ?? {})
    const live = await loadGroup(group)
    if (live === null) continue

    const label = group ? `${group}/${id}` : id
    const match = findById(live, id)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const { routes } = parseRoutes(item.fields.routes)
    if (!routes) continue
    const expected = canonicalJson(routes)
    const actual = canonicalJson(match.routes ?? [])
    if (expected !== actual) {
      diffs.push({ field: `${label}.routes`, expected: routes, actual: match.routes ?? [], severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

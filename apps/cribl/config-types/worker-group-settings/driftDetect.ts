import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, getJson, groupResourcePath } from '../../lib/criblApi'
import { itemsFromList, resolveWorkerGroup, canonicalJson } from '../../lib/criblCommon'
import { parseSettings, deepPick, WORKER_GROUP_SETTINGS_RESOURCE } from './_shared'

/**
 * Drift for Worker Group Settings: compare the DECLARED (partial) settings
 * object against the equivalent slice of the live object (read-only GET),
 * projected via deepPick so undeclared sibling fields never read as drift.
 * Best-effort — a group we can't read is skipped. Verify against a live Cribl.
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

  for (const item of items) {
    const group = resolveWorkerGroup(item.fields, settings ?? {})
    const { settings: declared } = parseSettings(item.fields.settings)
    if (!declared) continue

    const label = group || '(single-instance)'
    let live: Record<string, unknown> | null
    try {
      const rows = itemsFromList<Record<string, unknown>>(await getJson<unknown>(groupResourcePath(base, group, WORKER_GROUP_SETTINGS_RESOURCE), headers))
      live = rows[0] ?? null
    } catch {
      live = null
    }
    if (live === null) continue

    const projected = deepPick(live, declared)
    if (canonicalJson(declared) !== canonicalJson(projected)) {
      diffs.push({ field: label, expected: declared, actual: projected, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

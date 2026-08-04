import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import type { MispServerSetting } from './_shared'

/**
 * Drift for admin settings: compare the declared value against the live setting
 * in MISP. Best-effort — a setting that can't be read (not found, redacted, or a
 * transient error) is skipped rather than raising false drift. Values are
 * compared as strings since MISP casts booleans/numbers server-side and returns
 * them in native JSON types. Read-only: GET /servers/getSetting/<name> per
 * declared setting. Verify against a live MISP 2.4 instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    let live: MispServerSetting | null
    try {
      live = await getJson<MispServerSetting>(`${base}/servers/getSetting/${encodeURIComponent(name)}`, headers)
    } catch {
      continue // best-effort: not found, redacted, or transient — no drift asserted
    }
    if (!live) continue

    const expected = String(item.fields.value ?? '').trim()
    const actual = String(live.value ?? '')
    if (expected !== actual) {
      diffs.push({ field: name, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

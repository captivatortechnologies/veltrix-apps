import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'
import { parseEntries, entriesToMap, deriveFilename } from './_shared'

/**
 * Drift for CDB lists: compare the key:value entries we declare against the live
 * file on the manager. Best-effort — a list that can't be read (missing /
 * transient error) is skipped rather than raising false drift. A key that is
 * missing live, extra live, or has a different value each yields one diff.
 *
 * NOTE (verify against a live Wazuh 4.x manager): the live body is parsed with
 * the same `key:value` parser as authoring; if the API wraps the content in a
 * JSON envelope, the parser will treat non-matching lines as absent (no false
 * positives) — refine once the exact GET serialization is confirmed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  let baseUrl: string
  let auth: Record<string, string>
  try {
    const resolved = await getToken(component, connectivity, connectivityProvider, credential)
    baseUrl = resolved.baseUrl
    auth = bearerHeader(resolved.token)
  } catch {
    return { hasDrift: false, diffs } // can't authenticate — surface at deploy/health, not as drift
  }

  for (const item of items) {
    const filename = deriveFilename(item.fields.path, item.fields.listName)
    if (!filename) continue

    let liveBody: string
    try {
      const res = await wazuhRequest(`${baseUrl}/lists/files/${encodeURIComponent(filename)}`, { headers: auth })
      if (!res.ok) continue // best-effort: skip a list we can't read
      liveBody = res.body
    } catch {
      continue
    }

    const expected = entriesToMap(parseEntries(item.fields.entries).entries)
    const live = entriesToMap(parseEntries(liveBody).entries)

    for (const [key, value] of Object.entries(expected)) {
      if (!(key in live)) {
        diffs.push({ field: `${filename}.${key}`, expected: value, actual: null, severity: 'warning' })
      } else if (live[key] !== value) {
        diffs.push({ field: `${filename}.${key}`, expected: value, actual: live[key], severity: 'warning' })
      }
    }
    for (const key of Object.keys(live)) {
      if (!(key in expected)) {
        diffs.push({ field: `${filename}.${key}`, expected: null, actual: live[key], severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildClient, vqlTimeoutMs, readTools, findTool, INVENTORY_VQL, type LiveTool } from './_shared'

/**
 * Drift for third-party-tools: a declared tool missing on the server is critical
 * drift. A hash mismatch is critical (a supply-chain integrity failure — the
 * pinned binary was swapped or the pin drifted); a URL or version mismatch is a
 * warning. Read-only: SELECT * FROM inventory().
 *
 * VERIFY against a live Velociraptor server: inventory() row shape (see ./_shared.ts).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch {
    return { hasDrift: false, diffs }
  }

  try {
    let live: LiveTool[]
    try {
      live = readTools(await client.runVQL(INVENTORY_VQL, { timeoutMs: vqlTimeoutMs(settings) }))
    } catch {
      return { hasDrift: false, diffs }
    }

    for (const item of items) {
      const tool = String(item.fields.tool ?? '').trim()
      if (!tool) continue
      const match = findTool(live, tool)

      if (!match) {
        diffs.push({ field: `${tool}.presence`, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      const desiredHash = String(item.fields.hash ?? '').trim()
      if (desiredHash && match.hash !== desiredHash) {
        diffs.push({ field: `${tool}.hash`, expected: desiredHash, actual: match.hash || '(none)', severity: 'critical' })
      }

      const desiredUrl = String(item.fields.url ?? '').trim()
      if (desiredUrl && match.url !== desiredUrl) {
        diffs.push({ field: `${tool}.url`, expected: desiredUrl, actual: match.url || '(none)', severity: 'warning' })
      }

      const desiredVersion = String(item.fields.version ?? '').trim()
      if (desiredVersion && match.version !== desiredVersion) {
        diffs.push({ field: `${tool}.version`, expected: desiredVersion, actual: match.version || '(none)', severity: 'warning' })
      }
    }

    return { hasDrift: diffs.length > 0, diffs }
  } finally {
    await client.close().catch(() => {})
  }
}

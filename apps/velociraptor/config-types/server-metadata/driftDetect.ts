import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import {
  buildClient,
  vqlTimeoutMs,
  parseMetadataEntries,
  readServerMetadata,
  liveMetadataValue,
  GET_SERVER_METADATA_VQL,
} from './_shared'

/**
 * Drift for server-metadata: each declared key missing from the live server
 * metadata dict is critical drift; a key present with a different value is a
 * warning. Only the declared keys are compared — other metadata the server (or
 * another process) may carry is out of scope, matching deploy()'s upsert-only
 * semantics. Read-only: SELECT server_metadata().
 *
 * VERIFY against a live Velociraptor server: server_metadata() value shape.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  const diffs: DriftDiff[] = []

  if (!credential || !item) return { hasDrift: false, diffs }

  const entries = parseMetadataEntries(item.fields.metadata)
  if (entries.length === 0) return { hasDrift: false, diffs }

  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch {
    return { hasDrift: false, diffs }
  }

  try {
    let current: Record<string, unknown>
    try {
      current = readServerMetadata(await client.runVQL(GET_SERVER_METADATA_VQL, { timeoutMs: vqlTimeoutMs(settings) }))
    } catch {
      return { hasDrift: false, diffs }
    }

    for (const { key, value } of entries) {
      const actual = liveMetadataValue(current, key)
      if (actual === undefined) {
        diffs.push({ field: `metadata.${key}`, expected: value, actual: '(missing)', severity: 'critical' })
      } else if (actual !== value) {
        diffs.push({ field: `metadata.${key}`, expected: value, actual, severity: 'warning' })
      }
    }

    return { hasDrift: diffs.length > 0, diffs }
  } finally {
    await client.close().catch(() => {})
  }
}

import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildClient,
  vqlTimeoutMs,
  parseMetadataEntries,
  readServerMetadata,
  liveMetadataValue,
  serverSetMetadataVQL,
  GET_SERVER_METADATA_VQL,
} from './_shared'

/** One key's prior state, recorded so rollback can restore exactly it. */
interface PreviousEntry {
  key: string
  existed: boolean
  priorValue: string | null
}

/**
 * Deploy Velociraptor server metadata over the gRPC API (mutual TLS):
 *   read (rollback base): SELECT server_metadata()                      — full dict
 *   set (upsert-only):    SELECT server_set_metadata(metadata=<merged>) — one write
 *
 * Singleton: the first (only) item carries the declared key/value tags. Unlike
 * Server Monitoring's whole-list replace, this only TOUCHES the declared keys —
 * server_metadata is documented as free-form and may already carry keys this app
 * does not own, so they are read back into the merge and written through as-is.
 *
 * VERIFY against a live Velociraptor server: server_metadata() /
 * server_set_metadata() (see ./_shared.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]

  if (!credential) {
    return { success: false, message: 'Missing credential for server-metadata deployment' }
  }
  if (!item) {
    return { success: false, message: 'No server-metadata configuration to apply' }
  }

  const entries = parseMetadataEntries(item.fields.metadata)
  if (entries.length === 0) {
    return { success: true, message: 'No metadata keys declared — nothing to apply.', rollbackData: { previous: [] } }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  try {
    let current: Record<string, unknown> = {}
    try {
      current = readServerMetadata(await client.runVQL(GET_SERVER_METADATA_VQL, { timeoutMs }))
    } catch {
      current = {} // best-effort: without prior state, rollback can only clear the keys we set
    }

    const previous: PreviousEntry[] = entries.map(({ key }) => {
      const priorValue = liveMetadataValue(current, key)
      return { key, existed: priorValue !== undefined, priorValue: priorValue ?? null }
    })

    const merged: Record<string, string> = { ...(current as Record<string, string>) }
    for (const { key, value } of entries) merged[key] = value

    await client.runVQL(serverSetMetadataVQL(merged), { timeoutMs })

    return {
      success: true,
      message: `Applied ${entries.length} server metadata key(s): ${entries.map((e) => e.key).join(', ')}.`,
      artifacts: { applied: entries.map((e) => e.key) },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Server-metadata deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      rollbackData: { previous: [] },
    }
  } finally {
    await client.close().catch(() => {})
  }
}

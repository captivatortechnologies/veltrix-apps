import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { asBool } from '../../lib/velociraptorApi'
import { buildClient, vqlTimeoutMs, readTools, findTool, inventoryAddVQL, INVENTORY_VQL, type LiveTool } from './_shared'

/** One tool's rollback record: its prior definition, if it existed. */
export interface ToolRollbackEntry {
  tool: string
  existed: boolean
  prior: Pick<LiveTool, 'version' | 'url' | 'hash' | 'filename' | 'serveLocally'> | null
}

/**
 * Deploy Velociraptor third-party tool pins over the gRPC API (mutual TLS):
 *   read (rollback base): SELECT * FROM inventory()                — prior definitions
 *   upsert:                SELECT inventory_add(tool=, version=, url=, hash=, ...)
 *
 * The tool name is the practical upsert identity. There is no documented
 * `inventory_delete` — a tool this deploy newly adds cannot be un-added on
 * rollback, only flagged (see rollback.ts and README Coverage).
 *
 * VERIFY against a live Velociraptor server: inventory_add() upsert semantics
 * and the inventory() row shape (see ./_shared.ts).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for third-party-tools deployment' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  const previous: ToolRollbackEntry[] = []
  const applied: string[] = []
  try {
    let live: LiveTool[] = []
    try {
      live = readTools(await client.runVQL(INVENTORY_VQL, { timeoutMs }))
    } catch {
      live = [] // best-effort: without prior state, a newly-added tool can only be flagged, not restored
    }

    for (const item of items) {
      const tool = String(item.fields.tool ?? '').trim()
      const url = String(item.fields.url ?? '').trim()
      if (!tool || !url) continue

      const version = String(item.fields.version ?? '').trim() || undefined
      const hash = String(item.fields.hash ?? '').trim() || undefined
      const filename = String(item.fields.filename ?? '').trim() || undefined
      const serveLocally = asBool(item.fields.serveLocally, true)

      const existing = findTool(live, tool)
      previous.push({
        tool,
        existed: Boolean(existing),
        prior: existing
          ? { version: existing.version, url: existing.url, hash: existing.hash, filename: existing.filename, serveLocally: existing.serveLocally }
          : null,
      })

      await client.runVQL(inventoryAddVQL({ tool, version, url, hash, filename, serveLocally }), { timeoutMs })
      applied.push(tool)
    }

    return {
      success: true,
      message: `Applied ${applied.length} tool(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Third-party-tools deploy failed after ${applied.length} of ${items.length} tool(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } finally {
    await client.close().catch(() => {})
  }
}

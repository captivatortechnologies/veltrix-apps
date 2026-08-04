import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildClient, vqlTimeoutMs, inventoryAddVQL } from './_shared'
import type { ToolRollbackEntry } from './deploy'

/**
 * Undo a third-party-tools deploy from rollbackData.previous (written by
 * deploy()):
 *   - a tool that existed before with a known prior definition → restored via
 *     inventory_add() with the prior version/url/hash/filename/serve_locally
 *   - a tool this deploy CREATED (existed=false) → CANNOT be removed:
 *     Velociraptor's inventory API has no documented delete/remove plugin, so
 *     this is skipped and flagged rather than silently left as "rolled back"
 *     (see ./_shared.ts and README Coverage)
 * Applied over the gRPC API (mutual TLS).
 *
 * VERIFY against a live Velociraptor server: inventory_add() (see ./_shared.ts).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: ToolRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for third-party-tools rollback' }
  }

  const timeoutMs = vqlTimeoutMs(settings)
  let client
  try {
    client = await buildClient(component, credential, connectivity, settings)
  } catch (error) {
    return { success: false, message: `Could not connect to Velociraptor: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  let restored = 0
  let skipped = 0
  try {
    for (const { tool, existed, prior } of previous) {
      if (existed && prior) {
        await client.runVQL(
          inventoryAddVQL({
            tool,
            version: prior.version || undefined,
            url: prior.url || undefined,
            hash: prior.hash || undefined,
            filename: prior.filename || undefined,
            serveLocally: prior.serveLocally ?? true,
          }),
          { timeoutMs },
        )
        restored++
      } else {
        skipped++ // newly-created tool — Velociraptor's inventory has no delete plugin
      }
    }
    return {
      success: true,
      message: `Rolled back tools: ${restored} restored, ${skipped} skipped (Velociraptor's inventory API cannot remove a tool it created).`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  } finally {
    await client.close().catch(() => {})
  }
}

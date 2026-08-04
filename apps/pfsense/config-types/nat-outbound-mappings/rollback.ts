import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings } from '../../lib/pfsenseApi'
import type { RollbackEntry } from './deploy'

/** Undo a nat-outbound-mappings deploy from rollbackData.previous, in reverse order, then apply once via /api/v2/firewall/apply. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const auth = await client.authenticate()
  if (auth.error) return { success: false, message: auth.error }

  let restored = 0
  let deleted = 0

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.prior) {
        await client.updateOutboundNatMapping(entry.id, entry.prior)
        restored++
      } else {
        await client.deleteOutboundNatMapping(entry.id)
        deleted++
      }
    }

    if (restored > 0 || deleted > 0) {
      await client.applyChanges()
    }

    return { success: true, message: `Rolled back pfSense outbound NAT mappings: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

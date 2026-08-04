import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings } from '../../lib/pfsenseApi'
import { OUTBOUND_NAT_MODES } from './_shared'
import type { OutboundNatModeRollbackData } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousMode = (ctx.rollbackData as OutboundNatModeRollbackData | undefined)?.previousMode
  if (!previousMode || !OUTBOUND_NAT_MODES.includes(previousMode)) return { success: true, message: 'Nothing to roll back.' }
  if (!hasUsableCredential(ctx.credential)) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const built = buildPfsenseClient(ctx.component, ctx.connectivity, ctx.credential, readPfsenseSettings(ctx.settings), ctx.connectivityProvider)
  if ('error' in built) return { success: false, message: built.error }
  const auth = await built.client.authenticate()
  if (auth.error) return { success: false, message: auth.error }
  try {
    const current = await built.client.getOutboundNatMode()
    if (current !== previousMode) {
      await built.client.updateOutboundNatMode(previousMode)
      await built.client.applyChanges()
    }
    return { success: true, message: `Restored pfSense outbound NAT mode to ${previousMode}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

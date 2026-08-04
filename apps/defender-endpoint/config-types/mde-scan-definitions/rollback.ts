// =============================================================================
// Roll back a scan-definition deploy via the Defender API.
//
// Undo runs in reverse order. A definition this deploy CREATED (existed: false)
// is deleted via the batch-delete endpoint (Defender exposes no single-item
// DELETE for this resource). A definition this deploy UPDATED (existed: true)
// is restored via PATCH with its captured pre-deploy NON-SECRET fields
// (scanName / isActive / target / targetType / intervalInHours / scannerAgent)
// — `scanAuthenticationParams` is DELIBERATELY OMITTED from that PATCH.
//
// Per Microsoft's own docs, scanAuthenticationParams is "optional when updating
// a scan" and omitting it leaves whatever credential is currently live
// untouched. That means: if the forward deploy only changed structural fields,
// rollback fully restores prior behavior. If the forward deploy ALSO changed
// the SNMP credential, rollback cannot undo that credential change — Defender
// never reliably returns the credential for us to have captured it in the
// first place (see validate.ts). This is a documented, honest limitation of
// the underlying API, not a gap in this handler.
// =============================================================================

import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage } from '../../lib/mde'
import type { ScanDefinitionRollbackEntry } from './deploy'
import { SCAN_TYPE } from './validate'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScanDefinitionRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const credentialNote: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        const res = await client.request('POST', '/DeviceAuthenticatedScanDefinitions/BatchDelete', { body: { ScanDefinitionIds: [entry.id] } })
        if (!res.ok) throw new Error(`Failed to delete scan definition "${entry.scanName}": ${mdeErrorMessage(res)}`)
      } else if (entry.prior) {
        const res = await client.request('PATCH', `/DeviceAuthenticatedScanDefinitions/${entry.id}`, {
          body: {
            scanType: SCAN_TYPE,
            scanName: entry.prior.scanName,
            isActive: entry.prior.isActive,
            target: entry.prior.target,
            targetType: entry.prior.targetType,
            intervalInHours: entry.prior.intervalInHours,
            scannerAgent: { machineId: entry.prior.scannerMachineId },
            // scanAuthenticationParams intentionally omitted — see module comment.
          },
        })
        if (!res.ok) throw new Error(`Failed to restore scan definition "${entry.scanName}": ${mdeErrorMessage(res)}`)
        credentialNote.push(entry.scanName)
      }
      reverted.push(entry.scanName)
    }
    const caveat =
      credentialNote.length > 0
        ? ` (structural fields restored for ${credentialNote.length} definition(s); if the deploy also changed an SNMP credential, that credential could not be restored — Defender never returns it, see the module comment)`
        : ''
    return { success: true, message: `Rolled back ${reverted.length} scan definition(s)${caveat}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

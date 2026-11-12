import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'

export default async function rollback(_ctx: RollbackContext): Promise<RollbackResult> {
  return { success: false, message: 'Terms of Use agreement management requires delegated authentication; manage agreements in Entra and reference existing IDs in Conditional Access.' }
}

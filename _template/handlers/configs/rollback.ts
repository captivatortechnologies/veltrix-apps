// =============================================================================
// ROLLBACK HANDLER
//
// Called when a deployment fails or an admin triggers a rollback.
// Revert the component to the previous configuration.
//
// You receive ctx.rollbackData with whatever you returned from deploy().
// You receive ctx.targetVersion with the canvas snapshot to revert to.
// =============================================================================

import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, rollbackData, targetVersion } = ctx

  // Example: Restore previous config via API
  // if (connectivity?.httpsUrl && credential && rollbackData) {
  //   const response = await fetch(`${connectivity.httpsUrl}/api/config`, {
  //     method: 'PUT',
  //     headers: {
  //       'Authorization': `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
  //       'Content-Type': 'application/json',
  //     },
  //     body: JSON.stringify(rollbackData),
  //   })
  //
  //   if (!response.ok) {
  //     return { success: false, message: `Rollback failed: API returned ${response.status}` }
  //   }
  // }

  console.log(`[my-app] Rolling back ${component.hostname} to version ${targetVersion.version}`)

  return {
    success: true,
    message: `Rolled back ${component.hostname} to version ${targetVersion.version}`,
  }
}

// =============================================================================
// DEPLOY HANDLER
//
// Called by the pipeline engine to push configuration to your tool.
// This runs per-component (the engine handles targeting and strategy).
//
// You receive:
//   - ctx.component: the target host/server
//   - ctx.credential: authentication credentials for the tool
//   - ctx.connectivity: how to reach the component (SSH, HTTPS, Tailscale)
//   - ctx.canvas: the configuration data to deploy
//   - ctx.strategy: DIRECT, CANARY, BLUE_GREEN, or ROLLING
//
// Return { success: true } on success.
// Return { success: false, message: "why" } on failure (triggers rollback).
// Optionally return rollbackData that will be passed to your rollback handler.
// =============================================================================

import type { DeployContext } from '../../../server/src/core/pipeline-engine/types'
import type { DeployResult } from '../../../shared/types/pipeline'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx

  // Example: Deploy via HTTPS API
  // if (connectivity?.httpsUrl && credential) {
  //   const response = await fetch(`${connectivity.httpsUrl}/api/config`, {
  //     method: 'PUT',
  //     headers: {
  //       'Authorization': `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
  //       'Content-Type': 'application/json',
  //     },
  //     body: JSON.stringify({
  //       sections: canvas.sections,
  //     }),
  //   })
  //
  //   if (!response.ok) {
  //     return {
  //       success: false,
  //       message: `API returned ${response.status}: ${await response.text()}`,
  //     }
  //   }
  //
  //   const previousConfig = await response.json()
  //   return {
  //     success: true,
  //     message: `Configuration deployed to ${component.hostname}`,
  //     rollbackData: previousConfig, // Save for rollback
  //   }
  // }

  // Placeholder: Replace with your actual deployment logic
  console.log(`[my-app] Deploying to ${component.hostname}:${component.port}`)

  return {
    success: true,
    message: `Configuration deployed to ${component.hostname}`,
    rollbackData: { previousSnapshot: canvas.snapshot }, // Save current state for rollback
  }
}

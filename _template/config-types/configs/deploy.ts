// =============================================================================
// DEPLOY HANDLER
//
// Called by the pipeline engine to push configuration to your tool.
// This runs per-component (the engine handles targeting and strategy).
//
// You receive:
//   - ctx.component: the target host/server
//   - ctx.credential: authentication credentials for the tool
//   - ctx.connectivity: legacy per-component connectivity (SSH, HTTPS, Tailscale)
//   - ctx.connectivityProvider: platform-managed provider config (Tailscale, SSH, WireGuard, etc.)
//   - ctx.canvas: the configuration data to deploy
//   - ctx.strategy: DIRECT, CANARY, BLUE_GREEN, or ROLLING
//
// Return { success: true } on success.
// Return { success: false, message: "why" } on failure (triggers rollback).
// Optionally return rollbackData that will be passed to your rollback handler.
//
// TWO PATTERNS worth knowing (both proven by the Splunk + Okta apps):
//
//  • Rename-safety (idempotent updates). If your tool assigns its own external
//    ids, persist an item-id → external-id map in
//    `rollbackData.resourceIds` and read the LAST successful deploy's map via
//    `ctx.platform.getLatestDeployment()` at the start of a deploy. Then an edit
//    that renames an item UPDATES the same external object instead of recreating
//    it. EVERY deploy strategy must return rollbackData for this to hold.
//
//  • Managed ZTNA (file placement over the tailnet). When a server is reached
//    through a managed provider, `ctx.remote` (a RemoteExecutor) is present:
//    `ctx.remote.putFile()`, `.run()`, `.extractArchive()`, `.hashTree()`,
//    `.readFile()` run on the box over the tailnet — use it when the tool needs
//    files staged on disk rather than a pure API call. Build any HTTP URL from
//    `connectivityProvider.config.deviceAddress` (the tailnet host), never the
//    raw `.local` hostname (which won't resolve from the platform).
// =============================================================================

import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx

  // Example: Use the platform-managed connectivity provider
  // if (connectivityProvider) {
  //   switch (connectivityProvider.providerType) {
  //     case 'tailscale':
  //       // Access device via Tailscale — config has tailnet, apiKey
  //       break
  //     case 'ssh':
  //       // SSH into device — config has username, privateKey, port
  //       break
  //     case 'wireguard':
  //       // Tunnel via WireGuard — config has endpoint, privateKey
  //       break
  //   }
  // }

  // Example: Deploy via HTTPS API (legacy connectivity)
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

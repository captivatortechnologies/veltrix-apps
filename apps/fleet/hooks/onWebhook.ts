import type { AppWebhookContext } from '@veltrixsecops/app-sdk'

/** Inbound webhook hook — no webhook sources wired for v0.1.0. */
export default async function onWebhook({ source, event }: AppWebhookContext): Promise<void> {
  console.log(`[Fleet] webhook from ${source}: ${event}`)
}

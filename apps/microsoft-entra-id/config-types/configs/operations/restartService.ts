// =============================================================================
// OPERATION HANDLER — a one-off action (NOT a configuration deploy).
//
// Declared in the manifest under `operations`. The platform resolves the chosen
// connection's decrypted credential and runs this in-process; the secret is
// never returned. Trigger it from a client page via the platform's operations
// endpoint (POST /api/apps/<app>/operations/<operationId>).
//
// Keep operations idempotent and fast, and return a clear message.
// =============================================================================

interface OperationContext {
  appId: string
  customerId: string
  /** The server the operation runs against (chosen on the client). */
  component: { id: string; hostname: string; port?: string | null } | null
  /** Decrypted credential for that server. */
  credential: { username?: string | null; password?: string | null; apiToken?: string | null } | null
  /** Free-form params posted from the client. */
  params?: Record<string, unknown>
}

interface OperationResult {
  success: boolean
  message: string
}

export default async function restartService(ctx: OperationContext): Promise<OperationResult> {
  if (!ctx.component || !ctx.credential) {
    return { success: false, message: 'Select a server with a saved credential first.' }
  }

  // Replace with the real call to your tool (e.g. POST /services/server/control/restart).
  // await createToolClient({ baseUrl, token: ctx.credential.apiToken }).post('/restart', {})

  return { success: true, message: `Restart requested on ${ctx.component.hostname}.` }
}

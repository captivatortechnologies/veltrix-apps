import type { CredentialRef } from '@veltrixsecops/app-sdk'

// Local mirror of the platform's operation-handler contract. Declared here rather
// than imported from the SDK so handlers compile against whatever
// @veltrixsecops/app-sdk version the platform resolves at load time — only the
// long-standing CredentialRef type is imported. Mirrors the context the platform
// builds in POST /api/apps/:appId/operations/:operationId.

export interface OperationContext {
  appId: string
  customerId: string
  operationId: string
  /** Endpoint from the chosen connection (the stack URL), or null. */
  endpoint: string | null
  /** Decrypted credential for the chosen connection, or null. */
  credential: CredentialRef | null
  component: { hostname?: string | null } | null
  /** Operation-specific parameters supplied by the caller. */
  params: Record<string, unknown>
  settings: Record<string, unknown>
}

export interface OperationResult {
  ok: boolean
  message: string
  details?: string[]
  /** Optional structured payload (e.g. an exported package as base64). */
  data?: Record<string, unknown>
}

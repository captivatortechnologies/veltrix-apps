// Shared helpers for the JumpCloud Password Manager Policies config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// A per-tenant SINGLETON. Applied over the JumpCloud API v2:
//   GET /passwordmanager/company/policies             -> { id, disableExport }
//   PUT /passwordmanager/company/policies/{id}?disableExport=<bool>
//
// VERIFIED against JumpCloud's published API v2 OpenAPI spec
// (github.com/TheJumpCloud/jumpcloud-docs-public, docs/api/2.0/index.yaml):
// `disableExport` is sent as a QUERY PARAMETER on PUT, not a JSON body — the
// operation declares no requestBody, only a `disableExport` boolean parameter.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** The Password Manager organization policy object, as returned by GET. */
export interface JumpCloudPasswordManagerPolicy {
  id?: string
  disableExport?: boolean
  [key: string]: unknown
}

/** The desired state of the singleton, extracted from the canvas's one item. */
export interface PasswordManagerPolicySpec {
  disableExport: boolean
}

/** Coerce a checkbox-ish value to a boolean (defaults false — export allowed). */
export function normalizeDisableExport(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

/** The canvas has exactly one item describing the org-wide policy. */
export function extractPasswordManagerPolicySpecs(canvas: CanvasSnapshot): PasswordManagerPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return { disableExport: normalizeDisableExport(fields.disableExport) }
  })
}

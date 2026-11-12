import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTermsExpiration, effectiveFileName, effectiveLanguage, type TermsOfUseSpec } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the agreement existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** Prior PATCH-able metadata, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

/**
 * Body for POST /agreements. Creating REQUIRES at least one file with base64
 * fileData, so the PDF is wrapped in the `files` array (the shape the Graph
 * v1.0 create example uses). All metadata — including the create-only fields
 * (per-device acceptance, re-accept frequency, expiration) — is settable here.
 */
export function buildCreateBody(spec: TermsOfUseSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    displayName: spec.name,
    isViewingBeforeAcceptanceRequired: spec.viewingBeforeAcceptanceRequired,
    isPerDeviceAcceptanceRequired: spec.perDeviceAcceptanceRequired,
    files: [
      {
        fileName: effectiveFileName(spec),
        displayName: spec.name,
        language: effectiveLanguage(spec),
        isDefault: true,
        isMajorVersion: true,
        fileData: { data: spec.fileData },
      },
    ],
  }
  if (spec.reacceptFrequency) body.userReacceptRequiredFrequency = spec.reacceptFrequency
  const termsExpiration = buildTermsExpiration(spec)
  if (termsExpiration) body.termsExpiration = termsExpiration
  return body
}

/**
 * Body for PATCH /agreements/{id}. Graph v1.0 update only supports `displayName`
 * and `isViewingBeforeAcceptanceRequired`; the other metadata and the PDF are
 * create-only, so an update can never change them.
 */
export function buildPatchBody(spec: TermsOfUseSpec): Record<string, unknown> {
  return {
    displayName: spec.name,
    isViewingBeforeAcceptanceRequired: spec.viewingBeforeAcceptanceRequired,
  }
}

export default async function deploy(_ctx: DeployContext): Promise<DeployResult> {
  return { success: false, message: 'Terms of Use agreement management requires delegated authentication; manage agreements in Entra and reference existing IDs in Conditional Access.' }
}

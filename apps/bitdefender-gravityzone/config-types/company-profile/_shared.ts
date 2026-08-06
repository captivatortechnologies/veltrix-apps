// =============================================================================
// Shared helpers for the GravityZone Company Profile config type.
//
// A company always exists — there is no create/delete, only update — so
// this config type is reconciled by companyId (blank = the company linked
// to the calling API key) and only ever calls
// companies.updateCompanyDetails. Only fields the canvas declares
// NON-BLANK are managed; a blank field means "leave this field alone", not
// "clear it" (GravityZone's update parameters are all optional).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, coerceBoolean, parseJsonObject, readOptionalNumber, str } from '../../lib/gravityZoneCommon'
import type { GzCompanyDetails, GzUpdateCompanyBody } from '../../lib/gravityZoneApi'

export interface CompanyProfileSpec {
  itemName: string
  companyId: string
  name: string
  address: string
  phone: string
  industry: number | undefined
  country: string
  state: string
  enforce2FA: boolean | undefined
  enforce2FADeclared: boolean
  skip2FAPeriod: number | undefined
  contactPersonRaw: string
  mdrContactInformationRaw: string
}

/** The declaration's logical identity: its companyId (blank = the API key's own company). */
export function companyProfileKey(companyId: string): string {
  return companyId.trim().toLowerCase()
}

function declaredBoolean(raw: unknown): { value: boolean | undefined; declared: boolean } {
  const declared = raw !== undefined && raw !== ''
  return { value: declared ? coerceBoolean(raw, false) : undefined, declared }
}

export function extractCompanyProfileSpecs(canvas: CanvasSnapshot): CompanyProfileSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    const enforce2FA = declaredBoolean(fields.enforce2FA)
    return {
      itemName: item.name,
      companyId: str(fields.companyId),
      name: str(fields.name),
      address: str(fields.address),
      phone: str(fields.phone),
      industry: readOptionalNumber(fields.industry),
      country: str(fields.country),
      state: str(fields.state),
      enforce2FA: enforce2FA.value,
      enforce2FADeclared: enforce2FA.declared,
      skip2FAPeriod: readOptionalNumber(fields.skip2FAPeriod),
      contactPersonRaw: str(fields.contactPerson),
      mdrContactInformationRaw: str(fields.mdrContactInformation),
    }
  })
}

export function parseContactPerson(spec: CompanyProfileSpec): { value: Record<string, unknown> | null; error: string | null } {
  return parseJsonObject(spec.contactPersonRaw, `Company "${spec.companyId || '(own)'}" Contact Person`)
}

export function parseMdrContactInformation(spec: CompanyProfileSpec): { value: Record<string, unknown> | null; error: string | null } {
  return parseJsonObject(spec.mdrContactInformationRaw, `Company "${spec.companyId || '(own)'}" MDR Contact Information`)
}

/** Build the partial update body from only the fields the canvas declared non-blank. */
export function buildCompanyUpdateBody(
  spec: CompanyProfileSpec,
  contactPerson: Record<string, unknown> | null,
  mdrContactInformation: Record<string, unknown> | null,
): GzUpdateCompanyBody {
  const body: GzUpdateCompanyBody = {}
  if (spec.companyId) body.companyId = spec.companyId
  if (spec.name) body.name = spec.name
  if (spec.address) body.address = spec.address
  if (spec.phone) body.phone = spec.phone
  if (spec.industry !== undefined) body.industry = spec.industry
  if (spec.country) body.country = spec.country
  if (spec.state) body.state = spec.state
  if (spec.enforce2FADeclared) body.enforce2FA = spec.enforce2FA
  if (spec.skip2FAPeriod !== undefined) body.skip2FAPeriod = spec.skip2FAPeriod
  if (spec.contactPersonRaw && contactPerson) body.contactPerson = contactPerson
  if (spec.mdrContactInformationRaw && mdrContactInformation) body.mdrContactInformation = mdrContactInformation
  return body
}

/** The live values for every field this spec declares non-blank — for drift comparison and rollback capture. */
export function declaredLiveSnapshot(spec: CompanyProfileSpec, live: GzCompanyDetails): GzUpdateCompanyBody {
  const snap: GzUpdateCompanyBody = {}
  if (spec.name) snap.name = live.name ?? ''
  if (spec.address) snap.address = live.address ?? ''
  if (spec.phone) snap.phone = live.phone ?? ''
  if (spec.industry !== undefined) snap.industry = live.industry
  if (spec.country) snap.country = live.country ?? ''
  if (spec.state) snap.state = live.state ?? ''
  if (spec.enforce2FADeclared) snap.enforce2FA = live.enforce2FA
  if (spec.skip2FAPeriod !== undefined) snap.skip2FAPeriod = live.skip2FAPeriod
  if (spec.contactPersonRaw) snap.contactPerson = live.contactPerson ?? {}
  if (spec.mdrContactInformationRaw) snap.mdrContactInformation = live.mdrContactInformation ?? {}
  return snap
}

/** Does every field this spec declares non-blank already match the live company? */
export function companyFieldsMatch(
  spec: CompanyProfileSpec,
  contactPerson: Record<string, unknown> | null,
  mdrContactInformation: Record<string, unknown> | null,
  live: GzCompanyDetails,
): boolean {
  if (spec.name && live.name !== spec.name) return false
  if (spec.address && live.address !== spec.address) return false
  if (spec.phone && live.phone !== spec.phone) return false
  if (spec.industry !== undefined && live.industry !== spec.industry) return false
  if (spec.country && live.country !== spec.country) return false
  if (spec.state && live.state !== spec.state) return false
  if (spec.enforce2FADeclared && live.enforce2FA !== spec.enforce2FA) return false
  if (spec.skip2FAPeriod !== undefined && live.skip2FAPeriod !== spec.skip2FAPeriod) return false
  if (spec.contactPersonRaw && canonicalJson(live.contactPerson ?? {}) !== canonicalJson(contactPerson ?? {})) return false
  if (spec.mdrContactInformationRaw && canonicalJson(live.mdrContactInformation ?? {}) !== canonicalJson(mdrContactInformation ?? {})) return false
  return true
}

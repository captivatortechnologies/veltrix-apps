// Shared helpers for the HackerOne Credential Inquiries config type
// (deploy + rollback + drift). Pure + network-free so they can be unit-tested.
//
// A Credential Inquiry is a program's request, attached to ONE structured scope,
// describing what information HackerOne researchers must provide to be issued
// test credentials for that asset. Its only writable attribute is `description`.
//
//   Confirmed: https://api.hackerone.com/customer-resources/ (Credential Inquiries)
//     GET    /programs/{id}/credential_inquiries
//     POST   /programs/{id}/credential_inquiries
//              { structured_scope_id, data: { type: "credential_inquiry",
//                                             attributes: { description } } }
//     PUT    /programs/{program_id}/credential_inquiries/{id}
//              { data: { type: "credential_inquiry", attributes: { description } } }
//     DELETE /programs/{program_id}/credential_inquiries/{id}
//   Requires the Team Management permission on the API token.
//
// This config type reuses the generic program/scope resolution primitives in
// lib/programScopes.ts: a credential inquiry is addressed by (program handle +
// asset identifier); the asset identifier resolves to a structured_scope_id via
// the program's still-documented scope listing, and the inquiry is upserted by
// the scope it attaches to.

import type { JsonApiResource } from '../../lib/hackeroneApi'
import { str } from '../../lib/programScopes'

/** JSON:API resource `type` for a credential inquiry. */
export const CREDENTIAL_INQUIRY_TYPE = 'credential_inquiry'

/** Attributes of a HackerOne credential inquiry (only `description` is writable). */
export interface CredentialInquiryAttributes {
  description?: string
  structured_scope_id?: string | number
  [key: string]: unknown
}

/** One live inquiry as returned by GET /programs/{id}/credential_inquiries. */
export type LiveInquiry = JsonApiResource<CredentialInquiryAttributes>

/** The inquiry description a canvas item declares (trimmed). */
export function buildInquiryDescription(fields: Record<string, unknown>): string {
  return str(fields.description)
}

/**
 * JSON:API write document for updating a credential inquiry:
 *   { data: { type: "credential_inquiry", attributes: { description } } }
 */
export function inquiryWriteBody(description: string): { data: { type: string; attributes: { description: string } } } {
  return { data: { type: CREDENTIAL_INQUIRY_TYPE, attributes: { description } } }
}

/**
 * POST body for creating a credential inquiry on a scope. HackerOne places
 * `structured_scope_id` as a TOP-LEVEL sibling of `data` (not inside attributes).
 *   Confirmed: https://api.hackerone.com/customer-resources/ (Credential Inquiries)
 */
export function inquiryCreateBody(
  structuredScopeId: string,
  description: string,
): { structured_scope_id: string; data: { type: string; attributes: { description: string } } } {
  return { structured_scope_id: structuredScopeId, ...inquiryWriteBody(description) }
}

/**
 * Resolve the structured_scope_id a live credential inquiry is attached to.
 *
 * FLAGGED — the list response may carry the scope linkage either as an attribute
 * (`structured_scope_id`) or as a JSON:API relationship
 * (`relationships.structured_scope.data.id`); both are read here. Verify the
 * exact shape against live HackerOne.
 */
export function inquiryScopeId(inquiry: LiveInquiry): string {
  const attr = inquiry.attributes?.structured_scope_id
  if (attr !== undefined && attr !== null && String(attr).trim()) return String(attr).trim()
  const rel = inquiry.relationships as
    | { structured_scope?: { data?: { id?: string | number } } }
    | undefined
  const relId = rel?.structured_scope?.data?.id
  return relId !== undefined && relId !== null ? String(relId).trim() : ''
}

/** Index live inquiries by the structured_scope_id they attach to (one inquiry per scope). */
export function inquiriesByScopeId(inquiries: LiveInquiry[]): Map<string, LiveInquiry> {
  const map = new Map<string, LiveInquiry>()
  for (const inq of inquiries) {
    const sid = inquiryScopeId(inq)
    if (sid) map.set(sid, inq)
  }
  return map
}

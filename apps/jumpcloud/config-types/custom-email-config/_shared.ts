// Shared helpers for the JumpCloud Custom Email Configuration config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Applied over the JumpCloud API v2 (/customemails), keyed by `type` — a fixed
// enum with no separate generated id, so `type` IS both the identity and the
// path segment used to GET/PUT/DELETE a specific override.
//
// VERIFIED against JumpCloud's published API v2 OpenAPI spec
// (github.com/TheJumpCloud/jumpcloud-docs-public, docs/api/2.0/index.yaml):
//   CustomEmailType enum: activate_gapps_user | activate_o365_user |
//     lockout_notice_user | password_expiration | password_expiration_warning |
//     password_reset_confirmation | user_change_password | activate_user_custom
//   CustomEmail: { id, type*, subject*, title, header, body, button, nextStepContactInfo }

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const CUSTOM_EMAIL_TYPES = [
  'activate_gapps_user',
  'activate_o365_user',
  'lockout_notice_user',
  'password_expiration',
  'password_expiration_warning',
  'password_reset_confirmation',
  'user_change_password',
  'activate_user_custom',
] as const

export type CustomEmailType = (typeof CUSTOM_EMAIL_TYPES)[number]

/** One JumpCloud custom email override as returned by GET /customemails/{type}. */
export interface JumpCloudCustomEmail {
  id?: string
  type?: string
  subject?: string
  title?: string
  header?: string
  body?: string
  button?: string
  nextStepContactInfo?: string
  [key: string]: unknown
}

/** The desired state for one Custom Email override, extracted from a canvas item. */
export interface CustomEmailSpec {
  itemId?: string
  type: string
  subject: string
  title: string
  header: string
  body: string
  button: string
  nextStepContactInfo: string
}

/** Each canvas item describes one JumpCloud Custom Email override. */
export function extractCustomEmailSpecs(canvas: CanvasSnapshot): CustomEmailSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      type: String(fields.type ?? '').trim(),
      subject: String(fields.subject ?? '').trim(),
      title: String(fields.title ?? '').trim(),
      header: String(fields.header ?? '').trim(),
      body: String(fields.body ?? '').trim(),
      button: String(fields.button ?? '').trim(),
      nextStepContactInfo: String(fields.nextStepContactInfo ?? '').trim(),
    }
  })
}

/** Build the JumpCloud CustomEmail body for POST/PUT /customemails[/{type}]. */
export function buildCustomEmailBody(spec: CustomEmailSpec): Record<string, unknown> {
  return {
    type: spec.type,
    subject: spec.subject,
    title: spec.title,
    header: spec.header,
    body: spec.body,
    button: spec.button,
    nextStepContactInfo: spec.nextStepContactInfo,
  }
}

/** The subset of a live override's fields this config type manages — captured for rollback. */
export function priorFieldsOf(email: JumpCloudCustomEmail): Record<string, unknown> {
  return {
    type: String(email.type ?? ''),
    subject: String(email.subject ?? ''),
    title: String(email.title ?? ''),
    header: String(email.header ?? ''),
    body: String(email.body ?? ''),
    button: String(email.button ?? ''),
    nextStepContactInfo: String(email.nextStepContactInfo ?? ''),
  }
}

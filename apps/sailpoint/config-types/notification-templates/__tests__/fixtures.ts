// Shared fixtures for the notification-templates handler tests.
//
// A template is addressed by the triple (key, medium, locale) — there is no id
// and no update endpoint: POSTing a template replaces the custom override for
// that triple. The live fixture carries a different subject and body from the
// canvas, which is what the prior snapshot has to capture.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const KEY = 'cloud_manual_work_item_summary'
export const MEDIUM = 'EMAIL'
export const LOCALE = 'en'
export const BASE = '/beta/notification-templates'
export const BULK_DELETE = '/beta/notification-templates/bulk-delete'
export const LABEL = `${KEY} (${MEDIUM}/${LOCALE})`

export function templateItem(fields: Record<string, unknown> = {}) {
  return item(KEY, {
    key: KEY,
    name: 'Manual Work Item Summary',
    medium: MEDIUM,
    locale: LOCALE,
    subject: 'You have access requests waiting',
    body: '<p>There are items waiting for your decision.</p>',
    from: 'no-reply@acme.example',
    replyTo: 'servicedesk@acme.example',
    description: 'Daily summary of outstanding work items',
    ...fields,
  })
}

/** The override the tenant already has — stale subject and body. */
export function liveTemplate(over: Record<string, unknown> = {}) {
  return {
    key: KEY,
    name: 'Manual Work Item Summary (legacy)',
    medium: MEDIUM,
    locale: LOCALE,
    subject: 'Legacy subject nobody updated',
    body: '<p>Legacy body nobody updated.</p>',
    from: 'legacy-no-reply@acme.example',
    replyTo: 'legacy-servicedesk@acme.example',
    description: 'Legacy summary',
    ...over,
  }
}

/** A live template matching {@link templateItem} in every field drift tracks. */
export function inSyncTemplate(over: Record<string, unknown> = {}) {
  return {
    key: KEY,
    medium: MEDIUM,
    locale: LOCALE,
    subject: 'You have access requests waiting',
    body: '<p>There are items waiting for your decision.</p>',
    ...over,
  }
}

export const PRIOR = {
  key: KEY,
  medium: MEDIUM,
  locale: LOCALE,
  subject: 'Legacy subject nobody updated',
  body: '<p>Legacy body nobody updated.</p>',
  name: 'Manual Work Item Summary (legacy)',
  from: 'legacy-no-reply@acme.example',
  replyTo: 'legacy-servicedesk@acme.example',
  description: 'Legacy summary',
}

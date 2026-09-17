// Shared fixtures for the workflows handler tests.
//
// The canvas item declares the workflow DISABLED, because ISC refuses to create an
// enabled workflow and the handler has to enable it in a second call — the create
// contract asserts exactly one write, so the enable path gets its own test.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Joiner Notification'
export const LIVE_ID = 'wf-77b3aa'

/** What the canvas declares. */
export function workflowItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Emails the manager when a joiner is created',
    ownerId: 'id-owner-current',
    trigger: { type: 'EVENT', attributes: { id: 'idn:identity-created' } },
    definition: { start: 'notify', steps: { notify: { type: 'action' } } },
    enabled: false,
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveWorkflow(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    owner: { id: 'id-owner-departed' },
    trigger: { type: 'EVENT', attributes: { id: 'idn:identity-attributes-changed' } },
    definition: { start: 'legacyStep', steps: {} },
    enabled: true,
    ...over,
  }
}

/** A live object matching {@link workflowItem} in every field drift tracks. */
export function inSyncWorkflow(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Emails the manager when a joiner is created',
    owner: { id: 'id-owner-current' },
    enabled: false,
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveWorkflow}. */
export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  owner: { type: 'IDENTITY', id: 'id-owner-departed' },
  trigger: { type: 'EVENT', attributes: { id: 'idn:identity-attributes-changed' } },
  definition: { start: 'legacyStep', steps: {} },
  enabled: true,
}

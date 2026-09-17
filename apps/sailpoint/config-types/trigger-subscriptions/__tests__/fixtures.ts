// Shared fixtures for the trigger-subscriptions handler tests.
//
// The live subscription is disabled and carries a different filter, so the prior
// snapshot is a real record of what was — and was not — being delivered.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Joiner Webhook'
export const LIVE_ID = 'ts-3c44ef'

/** What the canvas declares. */
export function subscriptionItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    triggerId: 'idn:identity-created',
    type: 'HTTP',
    description: 'Notify the HR bot when an identity is created',
    responseDeadline: 'PT1H',
    enabled: true,
    filter: '$.identity.attributes.cloudLifecycleState',
    config: { url: 'https://hooks.example.test/joiner', httpDispatchMode: 'ASYNC' },
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveTriggerSubscription(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    triggerId: 'idn:identity-created',
    type: 'HTTP',
    description: 'Legacy description nobody updated',
    responseDeadline: 'PT10M',
    enabled: false,
    filter: '$.legacyFilter',
    ...over,
  }
}

/** A live object matching {@link subscriptionItem} in every field drift tracks. */
export function inSyncTriggerSubscription(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    triggerId: 'idn:identity-created',
    type: 'HTTP',
    description: 'Notify the HR bot when an identity is created',
    enabled: true,
    filter: '$.identity.attributes.cloudLifecycleState',
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveTriggerSubscription}. */
export const PRIOR = {
  name: NAME,
  description: 'Legacy description nobody updated',
  enabled: false,
  filter: '$.legacyFilter',
}

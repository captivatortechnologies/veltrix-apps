// rollback for cloud-rule-overrides.
//
// The shared contract covers the refusals every config type has. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch back what it overwrote — plus the entries that must
// produce NO write. Restoring is by RULE ID rather than by object id, because
// that is the identity this collection is addressed by.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  EMPTY,
  bodyOf,
  callsOfMethod,
  describeCalls,
  entityPage,
  forbidden,
  leaksSecret,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const ENTITY = /\/cloud-policies\/entities\/rule-overrides\/v1/

const CREATED_ENTRY = {
  ruleId: 'rule-1234',
  crn: 'crn:aws:111122223333',
  existed: false,
  id: 'ov-new-1',
}

const UPDATED_ENTRY = {
  ruleId: 'rule-1234',
  crn: 'crn:aws:111122223333',
  existed: true,
  id: 'ov-live-1',
  prior: {
    override_type: 'suppression',
    overrides_details: 'legacy details nobody updated',
    reason: 'temporary during the migration',
    comment: 'added by hand during an incident',
    target_region: 'eu-west-1',
    expires_at: '2026-06-01T00:00:00Z',
  },
}

/** The first entry of the wrapped `{ overrides: [ … ] }` write body. */
function overrideEntry(body: Record<string, unknown> | null): Record<string, unknown> | undefined {
  const overrides = body?.overrides
  return Array.isArray(overrides) ? (overrides[0] as Record<string, unknown>) : undefined
}

registerRollbackGuardContract({
  label: 'cloud-rule-overrides',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('cloud-rule-overrides rollback: deletes an override this deploy created', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([
        { id: 'ov-new-1', rule_id: 'rule-1234', crn: 'crn:aws:111122223333' },
      ]),
    },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=ov-new-1/)
    assert.equal(
      callsOfMethod(calls, 'PATCH').length,
      0,
      'a created override is deleted, not patched',
    )
  } finally {
    restore()
  }
})

test('cloud-rule-overrides rollback: writes nothing for a created entry with no live override and no recorded id', async () => {
  // Nothing identifies what to delete. Deleting whatever the read returned would
  // remove an override this deploy never made.
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'GET', respond: EMPTY }])
  try {
    const result = await rollback(
      rollbackContext({ previousState: [{ ruleId: 'rule-1234', existed: false }] }),
    )

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides rollback: restores the recorded prior values of an override it overwrote', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const entry = overrideEntry(bodyOf(patches[0]))
    assert.ok(entry, 'the restore body must be wrapped as { overrides: [ … ] }')
    assert.equal(entry.rule_id, 'rule-1234')
    assert.equal(entry.crn, 'crn:aws:111122223333', 'the restore must stay on the recorded scope')
    assert.equal(entry.override_type, 'suppression')
    assert.equal(entry.overrides_details, 'legacy details nobody updated')
    assert.equal(entry.reason, 'temporary during the migration')
    assert.equal(entry.comment, 'added by hand during an incident')
    assert.equal(entry.target_region, 'eu-west-1')
    assert.equal(entry.expires_at, '2026-06-01T00:00:00Z')
    assert.equal(
      callsOfMethod(calls, 'DELETE').length,
      0,
      'an updated override must never be deleted',
    )
  } finally {
    restore()
  }
})

test('cloud-rule-overrides rollback: clears the details and expiry the deploy added', async () => {
  // The override carried no details, no region and no expiry before the deploy.
  // Leaving the deployed values in place would make the rollback a silent no-op
  // for exactly the fields the deploy set — including an expiry that keeps a
  // built-in rule suppressed for years.
  const entry = { ruleId: 'rule-1234', existed: true, id: 'ov-live-1', prior: {} }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    const body = overrideEntry(bodyOf(callsOfMethod(calls, 'PATCH')[0])) ?? {}
    assert.equal(body.overrides_details, '')
    assert.equal(body.reason, '')
    assert.equal(body.target_region, '')
    assert.equal(body.expires_at, '')
    assert.equal(body.override_type, 'exception', 'an unrecorded type falls back to the only known one')
  } finally {
    restore()
  }
})

test('cloud-rule-overrides rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live override but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the override alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({ previousState: [{ ruleId: 'rule-1234', existed: true, id: 'ov-live-1' }] }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'ov-new-1', rule_id: 'rule-1234', crn: 'crn:aws:111122223333' }]),
    },
    { url: ENTITY, method: 'DELETE', respond: forbidden('access denied, authorization failed') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /access denied/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('override is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored override')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('cloud-rule-overrides rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, ruleId: 'rule-9876', id: 'ov-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})

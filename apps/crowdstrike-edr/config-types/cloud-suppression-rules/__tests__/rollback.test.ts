// rollback for cloud-suppression-rules.
//
// The shared contract covers the refusals every config type has. What is
// specific here is the two branches deploy's state feeds — delete what this
// deploy created, patch back what it overwrote — plus the entries that must
// produce NO write. A restore that invented a selection or a scope would leave
// findings suppressed that nobody ever agreed to suppress.

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
  idsPage,
  leaksSecret,
  ok,
  partialFailure,
  rollbackContext,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerRollbackGuardContract } from '../../../lib/__tests__/falconContracts'

const QUERIES = /\/cloud-policies\/queries\/suppression-rules\/v1/
const ENTITY = /\/cloud-policies\/entities\/suppression-rules\/v1/

const CREATED_ENTRY = { name: 'suppress-sandbox-noise', existed: false, id: 'sup-new-1' }

const UPDATED_ENTRY = {
  name: 'suppress-sandbox-noise',
  existed: true,
  id: 'sup-live-1',
  prior: {
    description: 'legacy description nobody updated',
    rule_selection_type: 'all',
    rule_selection_filter: { rule_severities: ['Critical'], rule_providers: ['azure'] },
    scope_type: 'resource',
    scope_asset_filter: { account_ids: ['999988887777'], regions: ['eu-west-1'] },
    suppression_reason: 'temporary during the migration',
    suppression_expiration_date: '2026-06-01T00:00:00Z',
    disabled: true,
  },
}

registerRollbackGuardContract({
  label: 'cloud-suppression-rules',
  handler: rollback,
  entry: CREATED_ENTRY,
})

test('cloud-suppression-rules rollback: deletes a rule this deploy created', async () => {
  const { calls, restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sup-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'sup-new-1', name: 'suppress-sandbox-noise' }]),
    },
    { url: ENTITY, method: 'DELETE', respond: ok() },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    const deletes = callsOfMethod(calls, 'DELETE')
    assert.equal(deletes.length, 1, `expected exactly one delete, got ${describeCalls(deletes)}`)
    assert.match(deletes[0].url, /ids=sup-new-1/)
    assert.equal(callsOfMethod(calls, 'PATCH').length, 0, 'a created rule is deleted, not patched')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules rollback: makes no delete when the created rule is already gone', async () => {
  // A concurrent delete must be a no-op, not a hard error — and never a delete
  // of whatever the id query happened to return.
  const { calls, restore } = routeFetch([{ url: QUERIES, respond: EMPTY }])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules rollback: restores the recorded prior selection and scope', async () => {
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, true)
    const patches = callsOfMethod(calls, 'PATCH')
    assert.equal(patches.length, 1, `expected exactly one restore, got ${describeCalls(patches)}`)

    const body = bodyOf(patches[0])
    assert.equal(body?.id, 'sup-live-1')
    assert.equal(body?.rule_selection_type, 'all')
    assert.deepEqual(body?.rule_selection_filter, {
      rule_severities: ['Critical'],
      rule_providers: ['azure'],
    })
    assert.equal(body?.scope_type, 'resource')
    assert.deepEqual(body?.scope_asset_filter, {
      account_ids: ['999988887777'],
      regions: ['eu-west-1'],
    })
    assert.equal(body?.description, 'legacy description nobody updated')
    assert.equal(body?.suppression_reason, 'temporary during the migration')
    assert.equal(body?.suppression_expiration_date, '2026-06-01T00:00:00Z')
    assert.equal(body?.disabled, true)
    assert.equal(callsOfMethod(calls, 'DELETE').length, 0, 'an updated rule must never be deleted')
  } finally {
    restore()
  }
})

test('cloud-suppression-rules rollback: clears the reason and expiry the deploy added', async () => {
  // The rule had no reason and no expiry before the deploy. Leaving the deployed
  // values in place would make the rollback a silent no-op for exactly the
  // fields the deploy set — including an expiry that keeps it alive for years.
  const entry = {
    name: 'suppress-sandbox-noise',
    existed: true,
    id: 'sup-live-1',
    prior: { rule_selection_type: 'all', scope_type: 'account' },
  }
  const { calls, restore } = routeFetch([{ url: ENTITY, method: 'PATCH', respond: ok() }])
  try {
    await rollback(rollbackContext({ previousState: [entry] }))

    const body = bodyOf(callsOfMethod(calls, 'PATCH')[0])
    assert.equal(body?.description, '')
    assert.equal(body?.suppression_reason, '')
    assert.equal(body?.suppression_expiration_date, '')
    assert.deepEqual(body?.rule_selection_filter, {}, 'an unrecorded filter restores as empty')
    assert.deepEqual(body?.scope_asset_filter, {})
  } finally {
    restore()
  }
})

test('cloud-suppression-rules rollback: writes nothing for an updated entry whose prior state was never captured', async () => {
  // Deploy overwrote a live rule but recorded no prior body. Restoring an
  // invented default here is strictly worse than leaving the rule alone.
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [{ name: 'suppress-sandbox-noise', existed: true, id: 'sup-live-1' }],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules rollback: writes nothing for an updated entry whose id was never captured', async () => {
  const { calls, restore } = routeFetch([], EMPTY)
  try {
    await rollback(
      rollbackContext({
        previousState: [
          {
            name: 'suppress-sandbox-noise',
            existed: true,
            prior: { rule_selection_type: 'all', scope_type: 'account' },
          },
        ],
      }),
    )

    assert.equal(writeCalls(calls).length, 0, `rollback wrote: ${describeCalls(writeCalls(calls))}`)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules rollback: reports a rejected delete rather than throwing', async () => {
  const { restore } = routeFetch([
    { url: QUERIES, respond: idsPage(['sup-new-1']) },
    {
      url: ENTITY,
      method: 'GET',
      respond: entityPage([{ id: 'sup-new-1', name: 'suppress-sandbox-noise' }]),
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

test('cloud-suppression-rules rollback: treats HTTP 200 with a populated errors[] as a failed restore', async () => {
  const { restore } = routeFetch([
    { url: ENTITY, method: 'PATCH', respond: partialFailure('rule is read-only') },
  ])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false, 'a populated errors[] under a 200 is not a restored rule')
    assert.match(String(result.message), /read-only/)
  } finally {
    restore()
  }
})

test('cloud-suppression-rules rollback: reports how far it got when a later entry fails', async () => {
  const { calls, restore } = routeFetch([
    {
      url: ENTITY,
      method: 'PATCH',
      respond: [ok(), forbidden('access denied, authorization failed')],
    },
  ])
  try {
    const second = { ...UPDATED_ENTRY, name: 'suppress-lab-noise', id: 'sup-live-2' }
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, second] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /1 of 2/)
    assert.equal(vendorCalls(calls).length, 2, 'both entries were attempted, in order')
  } finally {
    restore()
  }
})

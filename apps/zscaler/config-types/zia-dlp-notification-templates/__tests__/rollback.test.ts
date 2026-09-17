// rollback for zia-dlp-notification-templates.
//
// The shared contract covers the refusals (no credential, nothing recorded, an
// entry with no id or no prior body). What is specific here: the restore body is
// the prior subject and message bodies deploy captured, with both booleans
// replayed as recorded rather than re-defaulted; a template deploy created is
// DELETEd; a template already gone (404) is not an error; and the revert is
// itself a staged ZIA change.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import {
  ACTIVATED,
  NO_CONTENT,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  leaksSecret,
  notFound,
  ok,
  recordFetch,
  resourceCalls,
  rollbackContext,
  ziaError,
} from '../../../lib/__tests__/fakeZscaler'
import { registerRollbackGuardContract } from '../../../lib/__tests__/zscalerContracts'

registerRollbackGuardContract({
  label: 'zia-dlp-notification-templates',
  handler: rollback,
  product: 'zia',
  nameKey: 'name',
})

const UPDATED_ENTRY = {
  name: 'Acme DLP Notice',
  existed: true,
  id: 9901,
  prior: {
    name: 'Acme DLP Notice',
    subject: 'Policy notification',
    plainTextMessage: 'edited in the ZIA console',
    htmlMessage: '',
    tlsEnabled: false,
    attachContent: true,
  },
}

const CREATED_ENTRY = { name: 'New Notice', existed: false, id: 9910 }

test('zia-dlp-notification-templates rollback: restores the prior body of a template deploy overwrote', async () => {
  const { calls, restore } = recordFetch([TOKEN, ok({ id: 9901 }), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'PUT')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/dlpNotificationTemplates\/9901$/)
    const body = bodyOf(tenant[0])
    assert.equal(body?.subject, 'Policy notification')
    assert.equal(body?.plainTextMessage, 'edited in the ZIA console')
    assert.equal(body?.htmlMessage, '')
    assert.equal(body?.tlsEnabled, false, 'the restored flags are the prior ones, not the defaults')
    assert.equal(body?.attachContent, true)

    assert.equal(activateCalls(calls).length, 1, 'a staged revert is not a revert until it activates')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates rollback: deletes a template deploy created', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'DELETE')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/dlpNotificationTemplates\/9910$/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates rollback: undoes the newest change first', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT, ok({}), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY, CREATED_ENTRY] }))

    assert.deepEqual(
      resourceCalls(calls).map((c) => c.method),
      ['DELETE', 'PUT'],
      'the later entry is reverted before the earlier one',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates rollback: a template already gone is not an error', async () => {
  // 404 is a known answer — the template we would delete is already absent,
  // which is the state rollback was trying to reach.
  const { restore } = recordFetch([TOKEN, notFound(), ACTIVATED])
  try {
    const result = await rollback(rollbackContext({ previousState: [CREATED_ENTRY] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /Rolled back and activated 1/)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates rollback: a rejected restore fails rather than throwing', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaError(400, 'Template is referenced by a DLP rule')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Template is referenced by a DLP rule/)
    assert.equal(activateCalls(calls).length, 0, 'a failed revert must not be activated')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates rollback: a failed activation is reported as still-staged', async () => {
  const { restore } = recordFetch([TOKEN, ok({}), ziaError(409, 'Another activation is already in progress')])
  try {
    const result = await rollback(rollbackContext({ previousState: [UPDATED_ENTRY] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /Re-run rollback/)
  } finally {
    restore()
  }
})

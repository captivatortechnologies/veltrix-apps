// ============================================================================
// rollback for self-service sign-up (b2x) user flows, against a fake Graph.
//
// A user flow has no update operation, so rollback's only whole-object move is
// deletion — and it may only delete a flow THIS deploy created. A flow that was
// already in the tenant survives, and only the identity providers and attribute
// assignments this deploy itself added to it are taken back off. The two
// removals use DIFFERENT shapes and mixing them up is destructive:
//   identityProviders  -> DELETE .../identityProviders/{id}/$ref   (a de-link)
//   attribute assignment -> DELETE .../userAttributeAssignments/{id} (a real
//   sub-resource, no /$ref)
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  graphError,
  leaksSecret,
  notFound,
  recordFetch,
  rollbackContext,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import rollback from '../rollback'

const BASE = '/identity/b2xUserFlows'
const FLOW_ID = 'B2X_1_Partner'
const FACEBOOK = 'Facebook-OAUTH'
const GOOGLE = 'Google-OAUTH'
const CITY = 'city'
const SHOE_SIZE = 'extension_8a2b1c_shoeSize'

test('rollback refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(
      rollbackContext({ entries: [{ name: FLOW_ID, existed: false, id: FLOW_ID }] }, { credential: null }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('rollback deletes a flow the deploy created, without chasing its assignments', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: FLOW_ID,
            existed: false,
            id: FLOW_ID,
            identityProviders: [{ id: FACEBOOK, existed: false }],
            attributes: [{ id: CITY, existed: false }],
          },
        ],
      }),
    )

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 1, 'deleting the flow takes its providers and attributes with it')
    assert.equal(graphCalls[0].method, 'DELETE')
    assert.ok(graphCalls[0].url.endsWith(`${BASE}/${FLOW_ID}`))
    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted, 0 identity provider\/attribute assignment\(s\) revoked/)
  } finally {
    restore()
  }
})

test('a pre-existing flow is never deleted — only what this deploy added is taken back off', async () => {
  const { calls, restore } = routeFetch([{ url: /\/b2xUserFlows\//, method: 'DELETE', respond: NO_CONTENT }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [
          {
            name: FLOW_ID,
            existed: true,
            id: FLOW_ID,
            identityProviders: [
              { id: FACEBOOK, existed: false },
              { id: GOOGLE, existed: true },
            ],
            attributes: [
              { id: SHOE_SIZE, existed: false },
              { id: CITY, existed: true },
            ],
          },
        ],
      }),
    )

    assert.deepEqual(
      writeCalls(calls).map((c) => c.url.replace(/^.*\/v1\.0/, '')),
      [
        // A de-link of the provider...
        `${BASE}/${FLOW_ID}/identityProviders/${FACEBOOK}/$ref`,
        // ...and a real delete of the assignment sub-resource.
        `${BASE}/${FLOW_ID}/userAttributeAssignments/${SHOE_SIZE}`,
      ],
      'the provider and attribute that pre-dated this deploy must survive',
    )
    assert.equal(
      writeCalls(calls).some((c) => c.url.endsWith(`${BASE}/${FLOW_ID}`)),
      false,
      'the flow itself pre-existed and must not be deleted',
    )
    assert.match(String(result.message), /0 deleted, 2 identity provider\/attribute assignment\(s\) revoked/)
  } finally {
    restore()
  }
})

test('an identity provider is de-linked, never deleted from the directory', async () => {
  const { calls, restore } = recordFetch([TOKEN, NO_CONTENT])
  try {
    await rollback(
      rollbackContext({
        entries: [
          { name: FLOW_ID, existed: true, id: FLOW_ID, identityProviders: [{ id: FACEBOOK, existed: false }] },
        ],
      }),
    )

    // Without the trailing /$ref this would delete the identity provider object
    // itself, breaking every other flow that uses it.
    assert.ok(writeCalls(calls)[0].url.endsWith('/$ref'))
  } finally {
    restore()
  }
})

test('a flow already gone (404) is treated as already undone', async () => {
  const { restore } = recordFetch([TOKEN, notFound()])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: FLOW_ID, existed: false, id: FLOW_ID }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 deleted/)
  } finally {
    restore()
  }
})

test('an assignment already removed (404) is likewise not an error', async () => {
  const { restore } = routeFetch([{ url: /\/b2xUserFlows\//, method: 'DELETE', respond: notFound() }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ name: FLOW_ID, existed: true, id: FLOW_ID, attributes: [{ id: CITY, existed: false }] }],
      }),
    )

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 identity provider\/attribute assignment\(s\) revoked/)
  } finally {
    restore()
  }
})

test('an entry with no id is skipped rather than addressed by name', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: FLOW_ID, existed: false }] }))

    assert.equal(calls.length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a pre-existing flow with nothing tracked against it is left completely alone', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: FLOW_ID, existed: true, id: FLOW_ID }] }))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('rollback reports a Graph rejection rather than throwing, and leaks no secret', async () => {
  const { restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: FLOW_ID, existed: false, id: FLOW_ID }] }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /delete B2X_1_Partner/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('rollback does nothing when the deploy recorded no entries', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await rollback(rollbackContext(undefined))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

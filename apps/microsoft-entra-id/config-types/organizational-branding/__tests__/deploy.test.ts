// ============================================================================
// deploy for the tenant's default organizational branding.
//
// Branding is what every user of the tenant sees on the sign-in page, and the
// resource is addressed two levels in: /organization/{id}/branding, read and
// written with `Accept-Language: 0` — the header that selects the DEFAULT
// locale rather than a translation. Drop it and the write lands on whatever
// locale Graph infers, so the header is asserted on every call, not just the
// first. The other half is scope: the canvas manages only the fields the author
// filled in, so an empty field must never be sent as an empty value.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  deployContext,
  graphError,
  item,
  leaksSecret,
  notFound,
  recordFetch,
  resource,
  TOKEN,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy, { type RollbackEntry } from '../deploy'

const ORG_ID = '9f3c7a21-4b2e-4d6a-8c11-2a7e5f0b9d43'

/** GET /organization, which deploy needs before it can address branding. */
const ORG = collection([{ id: ORG_ID }])

function brandingItem(fields: Record<string, unknown> = {}) {
  return item('Default branding', {
    signInPageText: 'Authorised users only.',
    backgroundColor: '#0b1020',
    ...fields,
  })
}

function entriesOf(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

test('refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([brandingItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('an empty canvas succeeds without touching the tenant', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([]))

    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [])
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('an item with every field left blank writes nothing at all', async () => {
  const { calls, restore } = recordFetch([])
  try {
    // "Manage nothing" has to mean nothing — not "set every branding field to
    // the empty string", which would blank the tenant's sign-in page.
    const result = await deploy(deployContext([item('Default branding', {})]))

    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [])
    assert.equal(calls.length, 0, 'not even the organization lookup is worth a round trip')
  } finally {
    restore()
  }
})

test('resolves the organization id before addressing branding', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, resource({}), resource({})])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    assert.equal(result.success, true)
    const graph = assertAuthenticatedFirst(assert, calls)
    assert.match(graph[0].url, /\/organization\?\$select=id/)
    assert.match(graph[1].url, new RegExp(`/organization/${ORG_ID}/branding`))
    assert.match(graph[2].url, new RegExp(`/organization/${ORG_ID}/branding`))
  } finally {
    restore()
  }
})

test('fails rather than guessing when the organization id cannot be resolved', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /organization id/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('an empty /organization response is a failure, not an empty id in the path', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    assert.equal(result.success, false)
    assert.equal(writeCalls(calls).length, 0, 'a blank id would address /organization//branding')
  } finally {
    restore()
  }
})

test('every branding call carries the default-locale header', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, resource({}), resource({})])
  try {
    await deploy(deployContext([brandingItem()]))

    // Accept-Language: 0 is what makes this the DEFAULT branding rather than a
    // localized override — on the read as well as the write, or the recorded
    // prior state belongs to a different locale than the one being changed.
    for (const call of vendorCalls(calls).filter((c) => c.url.includes('/branding'))) {
      assert.equal(call.acceptLanguage, '0', `${call.method} ${call.url} lost the default-locale header`)
    }
  } finally {
    restore()
  }
})

test('sends only the fields the author filled in', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, resource({}), resource({})])
  try {
    await deploy(deployContext([brandingItem()]))

    // A blank field means "the tenant's existing value stands", so sending it
    // as '' would erase branding the canvas never claimed to manage.
    assert.deepEqual(bodyOf(writeCalls(calls)[0]), {
      signInPageText: 'Authorised users only.',
      backgroundColor: '#0b1020',
    })
  } finally {
    restore()
  }
})

test('updates with PATCH, so unmanaged branding fields survive', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, resource({}), resource({})])
  try {
    await deploy(deployContext([brandingItem()]))

    assert.equal(writeCalls(calls)[0].method, 'PATCH')
  } finally {
    restore()
  }
})

test('creates the default branding with PUT when the tenant has none yet', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, notFound(), notFound(), resource({})])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    assert.equal(result.success, true)
    const writes = writeCalls(calls)
    assert.deepEqual(
      writes.map((c) => c.method),
      ['PATCH', 'PUT'],
      'PATCH cannot create the object, so a 404 falls back to PUT',
    )
    assert.equal(writes[1].acceptLanguage, '0')
  } finally {
    restore()
  }
})

test('a rejected write is reported as a failed result, not thrown', async () => {
  const { restore } = recordFetch([TOKEN, ORG, resource({}), graphError(400, 'backgroundColor is not a valid color')])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /not a valid color/)
  } finally {
    restore()
  }
})

test('records the LIVE prior value for each field it writes', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ORG,
    resource({ signInPageText: 'Previous notice', backgroundColor: '#ffffff', usernameHintText: 'untouched' }),
    resource({}),
  ])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    assert.deepEqual(entriesOf(result), [
      {
        existed: true,
        orgId: ORG_ID,
        // Only the fields this deploy changed — restoring a field the deploy
        // never touched would undo someone else's work.
        prior: { signInPageText: 'Previous notice', backgroundColor: '#ffffff' },
      },
    ])
  } finally {
    restore()
  }
})

test('records an empty string for a field the tenant had not set', async () => {
  const { restore } = recordFetch([TOKEN, ORG, resource({ signInPageText: 'Previous notice' }), resource({})])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    // Not undefined: rollback has to be able to clear a value this deploy
    // introduced, which means telling "had none" from "not recorded".
    assert.equal(entriesOf(result)[0].prior?.backgroundColor, '')
  } finally {
    restore()
  }
})

test('stops before writing when the prior branding could not be read', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    // A failed read used to be substituted with `{}`, which recorded every
    // managed field's prior value as ''. Rollback PATCHes the prior back, so
    // the undo for this deploy would have BLANKED the tenant's sign-in page
    // rather than restoring what was there.
    assert.equal(result.success, false)
    assert.match(result.message, /Failed to read/)
    assert.equal(writeCalls(calls).length, 0)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('a tenant with no branding yet is a known prior, not an unknown one', async () => {
  const { calls, restore } = recordFetch([TOKEN, ORG, notFound(), notFound(), resource({})])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    // 404 means there is genuinely nothing there, so '' per field is the truth
    // and rollback clearing what this deploy added is the correct undo. Only an
    // unreadable prior is a reason to stop.
    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result)[0].prior, { signInPageText: '', backgroundColor: '' })
    assert.equal(writeCalls(calls).length, 2)
  } finally {
    restore()
  }
})

test('neither the token nor the client secret reaches the result', async () => {
  const { restore } = recordFetch([TOKEN, ORG, resource({}), resource({})])
  try {
    const result = await deploy(deployContext([brandingItem()]))

    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

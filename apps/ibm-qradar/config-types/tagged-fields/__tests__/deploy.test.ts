// deploy for tagged-fields.
//
// The shared contract covers the pre-flight refusals. What is specific here: the
// category is declared by NAME and resolved to category_id against a read-only
// lookup before writing, and five of the field's properties (name, type,
// private_enterprise_number, element_id, is_array) are IMMUTABLE in QRadar — an
// update may only ever carry category_id + description, so a live record that
// differs in an immutable property must fail rather than be half-written.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACCEPTED,
  assertQRadarHeaders,
  bodyOf,
  created,
  deployContext,
  item,
  leaksToken,
  list,
  pathOf,
  qradarError,
  routeFetch,
  writeCalls,
  type CannedResponse,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const FIELDS = '/ariel/taggedfields'
const CATEGORIES = '/ariel/taggedfieldcategories'

const ACME_CATEGORY = { id: 5, name: 'Acme Fields' }
const LEGACY_CATEGORY = { id: 9, name: 'Legacy Fields' }

const SESSION_ID = item(
  'acmeSessionId',
  {
    name: 'acmeSessionId',
    type: 'String',
    privateEnterpriseNumber: 32473,
    elementId: 12,
    isArray: false,
    categoryName: 'Acme Fields',
    description: 'Session identifier',
  },
  'item-session',
)

/** The live record that matches SESSION_ID exactly, before per-test edits. */
function liveField(over: Record<string, unknown> = {}) {
  return {
    id: 31,
    name: 'acmeSessionId',
    type: 'String',
    private_enterprise_number: 32473,
    element_id: 12,
    is_array: false,
    category_id: 5,
    description: 'Session identifier',
    ...over,
  }
}

registerDeployGuardContract({ label: 'tagged-fields', handler: deploy, sampleItems: [SESSION_ID] })

/** The category lookup and the field list fan out in a `Promise.all`, so match
 * on URL rather than imposing a call order that is not a contract. */
function fakeConsole(opts: {
  categories?: unknown[]
  fields?: unknown[]
  write?: CannedResponse
  remove?: CannedResponse
} = {}) {
  return routeFetch([
    { url: /\/ariel\/taggedfieldcategories/, respond: list(opts.categories ?? [ACME_CATEGORY, LEGACY_CATEGORY]) },
    { url: /\/ariel\/taggedfields/, method: 'GET', respond: list(opts.fields ?? []) },
    { url: /\/ariel\/taggedfields/, method: 'POST', respond: opts.write ?? created({ id: 77 }) },
    { url: /\/ariel\/taggedfields/, method: 'DELETE', respond: opts.remove ?? ACCEPTED },
  ])
}

function entriesOf(result: { rollbackData?: unknown }): Array<Record<string, unknown>> {
  return (result.rollbackData as { entries?: Array<Record<string, unknown>> } | undefined)?.entries ?? []
}

test('tagged-fields deploy: creates a field that does not exist, with the category resolved to its id', async () => {
  const { calls, restore } = fakeConsole({ fields: [] })
  try {
    const result = await deploy(deployContext([SESSION_ID]))

    assertQRadarHeaders(assert, calls)
    const reads = calls.filter((c) => c.method === 'GET')
    assert.ok(reads.some((c) => pathOf(c) === CATEGORIES), 'the category lookup must be read')
    assert.ok(reads.some((c) => pathOf(c) === FIELDS))
    assert.ok(reads.every((c) => c.range === 'items=0-9999'))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), FIELDS)
    assert.deepEqual(bodyOf(writes[0]), {
      name: 'acmeSessionId',
      type: 'String',
      private_enterprise_number: 32473,
      element_id: 12,
      category_id: 5,
      is_array: false,
      description: 'Session identifier',
    })

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 77)
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tagged-fields deploy: an unresolvable category name fails the item without writing it', async () => {
  // The lookup answered; the category simply does not exist. A write would put
  // `category_id: undefined` on the field and QRadar would file every tagged
  // event under whatever the console makes of that.
  const { calls, restore } = fakeConsole({ categories: [LEGACY_CATEGORY], fields: [] })
  try {
    const result = await deploy(deployContext([SESSION_ID]))

    assert.equal(writeCalls(calls).length, 0, 'an unresolved category must never reach a write')
    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown category "Acme Fields"/)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('tagged-fields deploy: updating a field sends only the two mutable properties', async () => {
  // The live record deliberately carries a different category and description
  // from the canvas, so an entry that recorded the DESIRED values as "prior"
  // would be caught here.
  const { calls, restore } = fakeConsole({
    fields: [liveField({ category_id: 9, description: 'Old description' })],
  })
  try {
    const result = await deploy(deployContext([SESSION_ID]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(pathOf(writes[0]), `${FIELDS}/31`)
    assert.deepEqual(
      bodyOf(writes[0]),
      { category_id: 5, description: 'Session identifier' },
      'an update must carry nothing else — the rest is immutable',
    )

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 31)
    assert.deepEqual(entries[0].prior, { categoryId: 9, description: 'Old description' })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tagged-fields deploy: a field that already matches is not written, but is still recorded', async () => {
  const { calls, restore } = fakeConsole({ fields: [liveField()] })
  try {
    const result = await deploy(deployContext([SESSION_ID]))

    assert.equal(writeCalls(calls).length, 0, 'an unchanged field must not be rewritten')
    const entries = entriesOf(result)
    assert.equal(entries.length, 1, 'rollback still needs to know the field was under management')
    assert.deepEqual(entries[0].prior, { categoryId: 5, description: 'Session identifier' })
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tagged-fields deploy: refuses a live record differing in any immutable property, without writing', async () => {
  // QRadar silently ignores these on an update, so a handler that tried anyway
  // would report success while the field kept parsing the wrong bytes.
  const mismatches: Array<Record<string, unknown>> = [
    { type: 'Integer' },
    { private_enterprise_number: 9999 },
    { element_id: 99 },
    { is_array: true },
  ]
  for (const over of mismatches) {
    const { calls, restore } = fakeConsole({ fields: [liveField(over)] })
    try {
      const result = await deploy(deployContext([SESSION_ID]))

      assert.equal(writeCalls(calls).length, 0, `${JSON.stringify(over)} must not be written`)
      assert.equal(result.success, false)
      assert.match(String(result.message), /cannot change immutable field\(s\)/)
      assert.deepEqual(entriesOf(result), [])
    } finally {
      restore()
    }
  }
})

test('tagged-fields deploy: refuses to rename the field recorded under this canvas item', async () => {
  // Matching by the recorded id is what makes a rename visible at all; the name
  // is immutable, so the rename must be refused rather than quietly ignored.
  const RENAMED = item(
    'acmeSessionToken',
    {
      name: 'acmeSessionToken',
      type: 'String',
      privateEnterpriseNumber: 32473,
      elementId: 12,
      isArray: false,
      categoryName: 'Acme Fields',
      description: 'Session identifier',
    },
    'item-session',
  )
  const { calls, restore } = fakeConsole({ fields: [liveField()] })
  try {
    const result = await deploy(
      deployContext([RENAMED], {
        priorRollbackData: { entries: [{ itemId: 'item-session', name: 'acmeSessionId', existed: true, id: 31 }] },
      }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /cannot change immutable field\(s\)/)
    assert.match(String(result.message), /name \(live "acmeSessionId" vs declared "acmeSessionToken"\)/)
  } finally {
    restore()
  }
})

test('tagged-fields deploy: a rejected create is a failed result, not a thrown error', async () => {
  const { restore } = fakeConsole({
    fields: [],
    write: qradarError(409, 'A tagged field with that enterprise number and element id already exists'),
  })
  try {
    const result = await deploy(deployContext([SESSION_ID]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('tagged-fields deploy: deletes a field it created before and no longer declares', async () => {
  const { calls, restore } = fakeConsole({ fields: [] })
  try {
    const result = await deploy(
      deployContext([SESSION_ID], {
        priorRollbackData: {
          entries: [
            { itemId: 'item-old', name: 'acmeRetired', existed: false, id: 41 },
            { itemId: 'item-op', name: 'operatorOwned', existed: true, id: 42 },
          ],
        },
      }),
    )

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => pathOf(c))
    assert.deepEqual(deletes, [`${FIELDS}/41`])
    assert.equal(
      deletes.some((p) => p.endsWith('/42')),
      false,
      'a field that pre-existed this app must never be reconcile-deleted',
    )
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('tagged-fields deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = fakeConsole({ fields: [] })
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

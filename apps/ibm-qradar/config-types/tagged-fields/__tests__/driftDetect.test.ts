// driftDetect for tagged-fields.
//
// The shared contract covers the refusals and the read-only rule. What is
// specific here is the severity split, and it is the whole point of the check:
// an immutable property that differs cannot be fixed by redeploying, so it is
// CRITICAL (an operator has to delete and recreate the field), while the
// category and description are WARNING because the next deploy repairs them.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, pathOf, routeFetch, writeCalls } from '../../../lib/__tests__/fakeQRadar'
import { registerDriftGuardContract } from '../../../lib/__tests__/qradarContracts'

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

registerDriftGuardContract({ label: 'tagged-fields', handler: driftDetect, sampleItems: [SESSION_ID] })

function fakeConsole(opts: { categories?: unknown[]; fields?: unknown[] } = {}) {
  return routeFetch([
    { url: /\/ariel\/taggedfieldcategories/, respond: list(opts.categories ?? [ACME_CATEGORY, LEGACY_CATEGORY]) },
    { url: /\/ariel\/taggedfields/, respond: list(opts.fields ?? []) },
  ])
}

test('tagged-fields driftDetect: reports in sync when the live field matches', async () => {
  const { calls, restore } = fakeConsole({ fields: [liveField()] })
  try {
    const result = await driftDetect(driftContext([SESSION_ID]))

    assert.ok(calls.some((c) => pathOf(c) === CATEGORIES))
    assert.ok(calls.some((c) => pathOf(c) === FIELDS))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('tagged-fields driftDetect: compares the deployed config, not the current canvas', async () => {
  // `driftContext` puts a decoy item on `ctx.canvas`; reading it would report
  // the real field as deleted.
  const { restore } = fakeConsole({ fields: [liveField()] })
  try {
    const result = await driftDetect(driftContext([SESSION_ID]))

    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('tagged-fields driftDetect: reports a field deleted in the console as critical', async () => {
  const { restore } = fakeConsole({ fields: [liveField({ id: 99, name: 'somethingElse' })] })
  try {
    const result = await driftDetect(driftContext([SESSION_ID]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: 'acmeSessionId', expected: 'present', actual: 'absent', severity: 'critical' },
    ])
  } finally {
    restore()
  }
})

test('tagged-fields driftDetect: flags every immutable mismatch as critical', async () => {
  // Critical is the signal that a redeploy cannot repair this: the field has to
  // be deleted and recreated, which loses the data already tagged under it.
  const cases: Array<{ over: Record<string, unknown>; field: string; expected: string; actual: string }> = [
    { over: { type: 'Integer' }, field: 'acmeSessionId.type', expected: 'String', actual: 'Integer' },
    { over: { private_enterprise_number: 9999 }, field: 'acmeSessionId.privateEnterpriseNumber', expected: '32473', actual: '9999' },
    { over: { element_id: 99 }, field: 'acmeSessionId.elementId', expected: '12', actual: '99' },
    { over: { is_array: true }, field: 'acmeSessionId.isArray', expected: 'false', actual: 'true' },
  ]
  for (const c of cases) {
    const { restore } = fakeConsole({ fields: [liveField(c.over)] })
    try {
      const result = await driftDetect(driftContext([SESSION_ID]))

      const diff = result.diffs.find((d) => d.field === c.field)
      assert.ok(diff, `expected a ${c.field} diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
      assert.equal(diff.expected, c.expected)
      assert.equal(diff.actual, c.actual)
      assert.equal(diff.severity, 'critical')
      assert.equal(result.hasDrift, true)
    } finally {
      restore()
    }
  }
})

test('tagged-fields driftDetect: flags a recategorised field as a warning', async () => {
  // The next deploy repairs this one, so it must not read as critical.
  const { restore } = fakeConsole({ fields: [liveField({ category_id: 9 })] })
  try {
    const result = await driftDetect(driftContext([SESSION_ID]))

    const diff = result.diffs.find((d) => d.field === 'acmeSessionId.categoryName')
    assert.ok(diff, `expected a categoryName diff, got ${result.diffs.map((d) => d.field).join(', ')}`)
    assert.equal(diff.expected, 'Acme Fields')
    assert.equal(diff.actual, '9')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('tagged-fields driftDetect: flags an edited description as a warning', async () => {
  const { restore } = fakeConsole({ fields: [liveField({ description: 'Edited in the console' })] })
  try {
    const result = await driftDetect(driftContext([SESSION_ID]))

    const diff = result.diffs.find((d) => d.field === 'acmeSessionId.description')
    assert.ok(diff)
    assert.equal(diff.expected, 'Session identifier')
    assert.equal(diff.actual, 'Edited in the console')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('tagged-fields driftDetect: reports every drifted property of a field, not just the first', async () => {
  const { restore } = fakeConsole({
    fields: [liveField({ type: 'Integer', category_id: 9, description: 'Edited in the console' })],
  })
  try {
    const result = await driftDetect(driftContext([SESSION_ID]))

    assert.deepEqual(
      result.diffs.map((d) => `${d.field}:${d.severity}`),
      [
        'acmeSessionId.type:critical',
        'acmeSessionId.categoryName:warning',
        'acmeSessionId.description:warning',
      ],
    )
  } finally {
    restore()
  }
})

test('tagged-fields driftDetect: an empty deployed config checks nothing and never writes', async () => {
  const { calls, restore } = fakeConsole({ fields: [] })
  try {
    const result = await driftDetect(driftContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

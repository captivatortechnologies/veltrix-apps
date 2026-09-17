// driftDetect for zpa-policy-rules.
//
// The shared contract covers the invariants. Specific here: a rule is re-found
// by name WITHIN its policy set, the diff field is labelled
// `<POLICY_TYPE>/<name>`, each targeted set is listed exactly once however many
// rules point at it, and attribution uses ZPA's bare `modifiedBy` admin id.
//
// The only field compared is `action` — `conditions` are deliberately not
// diffed by the handler (see its header) and `description` is not compared
// either, so no test here asserts anything about them; see the report.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  item,
  leaksSecret,
  recordFetch,
  resourceCalls,
  settingsWithoutCustomerId,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const RULE = item('Allow Finance to ERP', {
  name: 'Allow Finance to ERP',
  policy_type: 'ACCESS_POLICY',
  description: 'desired description',
  action: 'ALLOW',
  rule_order: 2,
})

registerDriftContract({
  label: 'zpa-policy-rules',
  handler: driftDetect,
  product: 'zpa',
  items: [RULE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: '216196257331370700',
  name: 'Allow Finance to ERP',
  description: 'desired description',
  action: 'ALLOW',
  ...over,
})

test('zpa-policy-rules driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([live()])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zpa-policy-rules driftDetect: reports a rule whose action was flipped by hand', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([live({ action: 'DENY' })])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'ACCESS_POLICY/Allow Finance to ERP.action')
    assert.ok(diff, `expected an action diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'ALLOW')
    assert.equal(diff.actual, 'DENY')
    assert.equal(diff.severity, 'warning')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zpa-policy-rules driftDetect: labels a deleted rule with its policy set', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([{ id: '1', name: 'Some Other Rule' }])])
  try {
    const result = await driftDetect(driftContext([RULE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'ACCESS_POLICY/Allow Finance to ERP')
    assert.ok(diff, `expected a missing diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'exists')
    assert.equal(diff.actual, 'missing')
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('zpa-policy-rules driftDetect: lists a policy set once however many rules target it', async () => {
  const second = item('Allow HR to Workday', {
    name: 'Allow HR to Workday',
    policy_type: 'ACCESS_POLICY',
    action: 'ALLOW',
  })
  const { calls, restore } = recordFetch([
    TOKEN,
    zpaList([live(), { id: '2', name: 'Allow HR to Workday', action: 'ALLOW' }]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE, second]))

    assert.equal(result.hasDrift, false)
    assert.equal(resourceCalls(calls).length, 1, 'one listing serves every rule in the set')
  } finally {
    restore()
  }
})

test('zpa-policy-rules driftDetect: attributes a manual change to the ZPA admin id that made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ action: 'DENY', modifiedBy: '216196257331370351', modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'ACCESS_POLICY/Allow Finance to ERP.action') as
      | { actor?: { id?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.id, '216196257331370351')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zpa-policy-rules driftDetect: does not attribute drift to our own OneAPI client', async () => {
  const { restore } = recordFetch([
    TOKEN,
    zpaList([live({ action: 'DENY', modifiedBy: CLIENT_ID, modifiedTime: '1600000000' })]),
  ])
  try {
    const result = await driftDetect(driftContext([RULE]))

    const diff = result.diffs.find((d) => d.field === 'ACCESS_POLICY/Allow Finance to ERP.action') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'a change recorded under our own client id is not a manual change')
  } finally {
    restore()
  }
})

test('zpa-policy-rules driftDetect: makes no call without a ZPA customer id', async () => {
  // NOTE: what this returns on this path is deliberately not asserted — see the
  // report. It cannot address the tenant at all, yet answers like a clean check.
  const { calls, restore } = recordFetch([])
  try {
    await driftDetect(driftContext([RULE], { settings: settingsWithoutCustomerId() }))

    assert.equal(calls.length, 0, 'ZPA is unaddressable without a customer id')
  } finally {
    restore()
  }
})

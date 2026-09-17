// driftDetect for rbac-labels.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff, and
// the rule that an unreadable tenant comes back `checked: false` rather than as a
// positive all-clear. What is specific here: the colour comparison, which is
// case-insensitive and skipped entirely when the canvas declares no colour.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE = '/rbac/labels'
const LABEL = item('veltrix-alpha', { name: 'veltrix-alpha', color: '#112233' })

registerDriftContract({
  label: 'rbac-labels',
  handler: driftDetect,
  basePath: BASE,
  items: [LABEL],
  inSync: [{ id: '4102', name: 'veltrix-alpha', color: '#112233' }],
  missingField: 'veltrix-alpha',
})

test('rbac-labels driftDetect: reports a colour changed in the tenant', async () => {
  const { restore } = routeFetch([
    { url: /\/rbac\/labels/, method: 'GET', respond: list([{ id: '4102', name: 'veltrix-alpha', color: '#ffeedd' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([LABEL]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.color')
    assert.ok(diff, `expected a colour diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '#112233')
    assert.equal(diff.actual, '#ffeedd')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('rbac-labels driftDetect: treats a colour that differs only in case as unchanged', async () => {
  const { restore } = routeFetch([
    { url: /\/rbac\/labels/, method: 'GET', respond: list([{ id: '4102', name: 'veltrix-alpha', color: '#112233' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([item('veltrix-alpha', { name: 'veltrix-alpha', color: '#112233' })]))
    assert.equal(result.hasDrift, false, JSON.stringify(result.diffs))

    const upper = await driftDetect(driftContext([item('veltrix-alpha', { name: 'veltrix-alpha', color: '#112233' })]))
    assert.equal(upper.hasDrift, false)
  } finally {
    restore()
  }
})

test('rbac-labels driftDetect: does not diff the colour when the canvas declares none', async () => {
  const { restore } = routeFetch([
    { url: /\/rbac\/labels/, method: 'GET', respond: list([{ id: '4102', name: 'veltrix-alpha', color: '#ffeedd' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([item('veltrix-alpha', { name: 'veltrix-alpha' })]))

    assert.equal(result.hasDrift, false, 'an undeclared colour is unmanaged, not drift')
    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

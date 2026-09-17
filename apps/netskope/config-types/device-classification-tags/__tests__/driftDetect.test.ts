// driftDetect for device-classification-tags.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here is the description
// comparison, including a tag whose description was cleared in the console.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/deviceclassification\/tags/
const TAG = item('veltrix-alpha', { name: 'veltrix-alpha', description: 'Managed by Veltrix' })

registerDriftContract({
  label: 'device-classification-tags',
  handler: driftDetect,
  basePath: '/deviceclassification/tags',
  items: [TAG],
  inSync: [{ id: '4102', name: 'veltrix-alpha', description: 'Managed by Veltrix' }],
  missingField: 'veltrix-alpha',
})

test('device-classification-tags driftDetect: reports a description changed in the tenant', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ id: '4102', name: 'veltrix-alpha', description: 'edited in the console' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([TAG]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'Managed by Veltrix')
    assert.equal(diff.actual, 'edited in the console')
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('device-classification-tags driftDetect: reports a description cleared in the tenant', async () => {
  // `null` is what Netskope returns for a description someone emptied, and it
  // must read as a change rather than as "not managed".
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ id: '4102', name: 'veltrix-alpha', description: null }]) },
  ])
  try {
    const result = await driftDetect(driftContext([TAG]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.description')
    assert.ok(diff)
    assert.equal(diff.actual, '')
  } finally {
    restore()
  }
})

test('device-classification-tags driftDetect: matches the tenant name case-insensitively', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([{ id: '4102', name: 'VELTRIX-ALPHA', description: 'Managed by Veltrix' }]) },
  ])
  try {
    const result = await driftDetect(driftContext([TAG]))

    assert.equal(result.hasDrift, false, 'a case difference in the name is not a deleted tag')
  } finally {
    restore()
  }
})

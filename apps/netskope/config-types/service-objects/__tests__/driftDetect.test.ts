// driftDetect for service-objects.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: every port list is diffed
// (order-insensitively), ICMP is diffed, and a Netskope PREDEFINED object is
// excluded from matching — otherwise a built-in sharing a name would mask the
// deletion of the object this app actually manages.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/profiles\/serviceobjects/
const OBJECT = item('veltrix-alpha', { name: 'veltrix-alpha', icmp: false, tcp: '443,8443' })

registerDriftContract({
  label: 'service-objects',
  handler: driftDetect,
  basePath: '/profiles/serviceobjects',
  items: [OBJECT],
  inSync: [{ id: '4102', name: 'veltrix-alpha', type: 'custom', protocols: { tcp: ['443', '8443'] } }],
  missingField: 'veltrix-alpha',
})

test('service-objects driftDetect: reports a port opened in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ id: '4102', name: 'veltrix-alpha', type: 'custom', protocols: { tcp: ['443', '8443', '22'] } }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([OBJECT]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.tcp')
    assert.ok(diff, `expected a tcp diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '443,8443')
    assert.equal(diff.actual, '22,443,8443')
  } finally {
    restore()
  }
})

test('service-objects driftDetect: reports ICMP turned on in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ id: '4102', name: 'veltrix-alpha', type: 'custom', protocols: { icmp: true, tcp: ['443', '8443'] } }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([OBJECT]))

    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.icmp')
    assert.ok(diff, `expected an icmp diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'false')
    assert.equal(diff.actual, 'true')
  } finally {
    restore()
  }
})

test('service-objects driftDetect: a PREDEFINED object of the same name does not mask a deletion', async () => {
  // The managed custom object is gone; only a Netskope built-in shares its name.
  // Counting the built-in as a match would report the tenant as in sync while
  // every policy referencing the custom object now matches something else.
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ id: '1', name: 'veltrix-alpha', type: 'PREDEFINED', protocols: { tcp: ['443', '8443'] } }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([OBJECT]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].field, 'veltrix-alpha')
    assert.equal(result.diffs[0].actual, 'absent')
    assert.equal(result.diffs[0].severity, 'critical')
  } finally {
    restore()
  }
})

test('service-objects driftDetect: treats a reordered port list as unchanged', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ id: '4102', name: 'veltrix-alpha', type: 'custom', protocols: { tcp: ['8443', '443'] } }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([OBJECT]))

    assert.equal(result.hasDrift, false, `order is not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

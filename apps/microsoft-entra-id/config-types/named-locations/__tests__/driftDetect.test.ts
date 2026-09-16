// ============================================================================
// driftDetect for Conditional Access named locations, against a fake Graph.
//
// Someone flipping a location to "trusted", or widening its CIDR list, changes
// who skips MFA without touching a single policy. These pin the diffs the
// handler raises for exactly those edits.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const IP_TYPE = '#microsoft.graph.ipNamedLocation'

function ipItem(fields: Record<string, unknown> = {}) {
  return item('Corp IPs', { name: 'Corp IPs', type: 'ip', ipRanges: '203.0.113.0/24', ...fields })
}

function liveIp(over: Record<string, unknown> = {}) {
  return {
    id: 'loc-1',
    '@odata.type': IP_TYPE,
    displayName: 'Corp IPs',
    isTrusted: false,
    ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' }],
    ...over,
  }
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([ipItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await driftDetect(driftContext([ipItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the live location matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([liveIp()])])
  try {
    const result = await driftDetect(driftContext([ipItem()]))

    assertAuthenticatedFirst(assert, calls)
    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
  } finally {
    restore()
  }
})

test('a deleted location is critical drift', async () => {
  const { restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await driftDetect(driftContext([ipItem()]))

    assert.deepEqual(result.diffs[0], {
      field: 'Corp IPs',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
  } finally {
    restore()
  }
})

test('a location someone marked trusted in the portal surfaces as drift', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveIp({ isTrusted: true })])])
  try {
    const result = await driftDetect(driftContext([ipItem()]))

    const diff = result.diffs.find((d) => d.field === 'Corp IPs.isTrusted')
    assert.ok(diff, 'a location silently promoted to trusted exempts its users from MFA')
    assert.equal(diff.expected, false)
    assert.equal(diff.actual, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a CIDR range added out of band surfaces as drift', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([
      liveIp({
        ipRanges: [
          { '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' },
          { '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '0.0.0.0/0' },
        ],
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([ipItem()]))

    const diff = result.diffs.find((d) => d.field === 'Corp IPs.ipRanges')
    assert.ok(diff)
    assert.deepEqual(diff.expected, ['203.0.113.0/24'])
    assert.deepEqual(diff.actual, ['0.0.0.0/0', '203.0.113.0/24'])
  } finally {
    restore()
  }
})

test('a country location compares its country list and unknown-region flag', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([
      {
        id: 'loc-2',
        '@odata.type': '#microsoft.graph.countryNamedLocation',
        displayName: 'Blocked countries',
        countriesAndRegions: ['GB'],
        includeUnknownCountriesAndRegions: true,
      },
    ]),
  ])
  try {
    const result = await driftDetect(
      driftContext([
        item('Blocked countries', { name: 'Blocked countries', type: 'country', countries: 'GB, US' }),
      ]),
    )

    const countries = result.diffs.find((d) => d.field === 'Blocked countries.countries')
    assert.ok(countries)
    assert.deepEqual(countries.expected, ['GB', 'US'])
    assert.deepEqual(countries.actual, ['GB'])

    const unknown = result.diffs.find((d) => d.field === 'Blocked countries.includeUnknown')
    assert.ok(unknown)
    assert.equal(unknown.severity, 'info')
  } finally {
    restore()
  }
})

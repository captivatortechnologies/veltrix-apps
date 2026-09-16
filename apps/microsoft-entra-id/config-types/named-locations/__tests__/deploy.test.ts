// ============================================================================
// deploy for Conditional Access named locations, against a fake Microsoft Graph.
//
// `isTrusted` is the field to watch: a named location marked trusted is what
// Conditional Access policies exempt from MFA, so a location created trusted by
// accident is a standing bypass. These assert the flag actually sent, along with
// the create/update split and the prior state deploy records for rollback.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  ok,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/identity/conditionalAccess/namedLocations'
const IP_TYPE = '#microsoft.graph.ipNamedLocation'
const COUNTRY_TYPE = '#microsoft.graph.countryNamedLocation'

function ipItem(fields: Record<string, unknown> = {}) {
  return item('Corp IPs', { name: 'Corp IPs', type: 'ip', ipRanges: '203.0.113.0/24', ...fields })
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([ipItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges.')])
  try {
    const result = await deploy(deployContext([ipItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list named locations/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates an IP location UNTRUSTED unless asked', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'loc-new' })])
  try {
    const result = await deploy(deployContext([ipItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    const post = graphCalls.find((c) => c.method === 'POST')
    assert.ok(post)
    assert.ok(post.url.includes(BASE))

    const body = bodyOf(post)
    assert.ok(body)
    assert.equal(body['@odata.type'], IP_TYPE)
    // A trusted location is exempt from MFA in Conditional Access. Defaulting
    // it to true would hand out a bypass nobody asked for.
    assert.equal(body.isTrusted, false)
    assert.deepEqual(body.ipRanges, [
      { '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '203.0.113.0/24' },
    ])
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy marks a location trusted only when the canvas says so', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'loc-new' })])
  try {
    await deploy(deployContext([ipItem({ isTrusted: true })]))

    assert.equal(bodyOf(writeCalls(calls)[0])?.isTrusted, true)
  } finally {
    restore()
  }
})

test('an IPv6 range is tagged with the IPv6 CIDR type, not the IPv4 one', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'loc-new' })])
  try {
    await deploy(deployContext([ipItem({ ipRanges: '2001:db8::/32' })]))

    assert.deepEqual(bodyOf(writeCalls(calls)[0])?.ipRanges, [
      { '@odata.type': '#microsoft.graph.iPv6CidrRange', cidrAddress: '2001:db8::/32' },
    ])
  } finally {
    restore()
  }
})

test('a country location sends countriesAndRegions, upper-cased, with the country odata type', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'loc-new' })])
  try {
    await deploy(
      deployContext([item('Blocked countries', { name: 'Blocked countries', type: 'country', countries: 'gb, us' })]),
    )

    const body = bodyOf(writeCalls(calls)[0])
    assert.ok(body)
    assert.equal(body['@odata.type'], COUNTRY_TYPE)
    assert.deepEqual(body.countriesAndRegions, ['GB', 'US'])
    assert.equal(body.includeUnknownCountriesAndRegions, false)
  } finally {
    restore()
  }
})

test('deploy updates an existing location and records its LIVE prior body', async () => {
  const livePrior = {
    id: 'loc-1',
    '@odata.type': IP_TYPE,
    displayName: 'Corp IPs',
    isTrusted: true,
    ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: '198.51.100.0/24' }],
  }
  const { calls, restore } = recordFetch([TOKEN, collection([livePrior]), ok({})])
  try {
    const result = await deploy(deployContext([ipItem()]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.includes(`${BASE}/loc-1`))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    // The trusted flag the tenant HAD, so rollback can put it back.
    assert.deepEqual(entries[0].prior, {
      '@odata.type': IP_TYPE,
      displayName: 'Corp IPs',
      isTrusted: true,
      ipRanges: livePrior.ipRanges,
    })
    assert.equal(bodyOf(writes[0])?.isTrusted, false, 'the deploy sends the canvas value, not the prior one')
  } finally {
    restore()
  }
})

test('deploy reports a rejected write rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'A named location with this name already exists.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([ipItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy deletes a location it created earlier and the canvas no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Retired', existed: false, id: 'loc-old' },
            { name: 'Pre-existing', existed: true, id: 'loc-keep', prior: {} },
          ],
        },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.ok(deletes[0].url.includes(`${BASE}/loc-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

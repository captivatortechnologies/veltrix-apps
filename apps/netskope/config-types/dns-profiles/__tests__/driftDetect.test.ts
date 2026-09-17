// driftDetect for dns-profiles.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: the logging mode and the
// description, the two stable scalar fields. The nested config blobs are not
// diffed on purpose — the API materialises defaults into them, so a user's
// partial JSON never round-trips and every run would report false drift; the
// deploy re-sends them instead.
//
// NOTE: drift here does NOT retry a "migration in progress" listing the way
// deploy does, so a tenant mid-upgrade comes back unchecked. That is the safe
// direction, but it is a difference between the two handlers rather than a
// decision — see the report accompanying these tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, list, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/profiles\/dns/
const PROFILE = item('veltrix-alpha', {
  name: 'veltrix-alpha',
  description: 'Managed by Veltrix',
  log_traffic: 'All DNS',
  domain_config: '{"action":"block"}',
})

registerDriftContract({
  label: 'dns-profiles',
  handler: driftDetect,
  basePath: '/profiles/dns',
  items: [PROFILE],
  inSync: [{ profile_id: '4102', name: 'veltrix-alpha', description: 'Managed by Veltrix', log_traffic: 'All DNS' }],
  missingField: 'veltrix-alpha',
})

test('dns-profiles driftDetect: reports DNS logging narrowed in the console', async () => {
  // Going from "All DNS" to "Blocked DNS" silently stops recording the lookups
  // an investigation would need.
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([{ profile_id: '4102', name: 'veltrix-alpha', description: 'Managed by Veltrix', log_traffic: 'Blocked DNS' }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PROFILE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.log_traffic')
    assert.ok(diff, `expected a log_traffic diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'All DNS')
    assert.equal(diff.actual, 'Blocked DNS')
  } finally {
    restore()
  }
})

test('dns-profiles driftDetect: does not report the materialised config blobs as drift', async () => {
  // The API fills defaults into the nested blobs, so the live copy never equals
  // the partial JSON the canvas declared. Diffing it would report drift on every
  // single run and train operators to ignore the signal.
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: list([
        {
          profile_id: '4102',
          name: 'veltrix-alpha',
          description: 'Managed by Veltrix',
          log_traffic: 'All DNS',
          domain_config: { action: 'block', ttl: 300, materialised_default: true },
        },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([PROFILE]))

    assert.equal(result.hasDrift, false, `expected no drift, got ${JSON.stringify(result.diffs)}`)
    assert.notEqual(result.checked, false, 'it did look — the blobs are simply not comparable')
  } finally {
    restore()
  }
})

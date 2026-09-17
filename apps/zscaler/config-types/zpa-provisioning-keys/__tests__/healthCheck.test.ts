// healthCheck for zpa-provisioning-keys.
//
// The shared contract covers the refusals, the token-first probe and the error
// handling; the probe here is the **v2** /enrollmentCert endpoint the keys
// depend on, with an /appConnectorGroup probe as the fallback for tenants that
// do not expose v2 — so "unreachable" only holds once BOTH have failed.
// Specific beyond that: keys are looked for within their association type, and
// a listing carrying the key secret must not put it into the result.

import test from 'node:test'
import assert from 'node:assert/strict'
import healthCheck from '../healthCheck'
import {
  TOKEN,
  ZPA_CUSTOMER_ID,
  healthContext,
  item,
  notFound,
  recordFetch,
  serverError,
  writeCalls,
  zpaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerHealthCheckContract } from '../../../lib/__tests__/zscalerContracts'
import { PROVISIONING_KEY, leaksProvisioningKey } from './keySecret'

registerHealthCheckContract({
  label: 'zpa-provisioning-keys',
  handler: healthCheck,
  product: 'zpa',
  probePath: `/zpa/mgmtconfig/v2/admin/customers/${ZPA_CUSTOMER_ID}/enrollmentCert`,
})

const KEY = item('SJC Connector Key', {
  name: 'SJC Connector Key',
  association_type: 'CONNECTOR_GRP',
  max_usage: 5,
  component_group_name: 'San Jose Connectors',
  enrollment_cert_name: 'Connector',
  enabled: true,
})

const LIVE = { id: '216196257331370800', name: 'SJC Connector Key', provisioningKey: PROVISIONING_KEY }

test('zpa-provisioning-keys healthCheck: passes when every declared key is present, without echoing the secret', async () => {
  const { calls, restore } = recordFetch([TOKEN, zpaList([{ id: 'cert-1', name: 'Connector' }]), zpaList([LIVE])])
  try {
    const result = await healthCheck(healthContext([KEY]))

    assert.equal(result.healthy, true)
    assert.equal(result.score, 100)
    const check = result.checks.find((c) => c.name === 'provisioningKey:CONNECTOR_GRP/SJC Connector Key')
    assert.ok(check, `expected a per-key check, got ${result.checks.map((c) => c.name).join(', ')}`)
    assert.equal(check.passed, true)
    assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    assert.equal(
      leaksProvisioningKey(result),
      false,
      'the listing carries the key value — the health result must not',
    )
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys healthCheck: fails when a declared key has been deleted in the tenant', async () => {
  const { restore } = recordFetch([TOKEN, zpaList([{ id: 'cert-1', name: 'Connector' }]), zpaList([])])
  try {
    const result = await healthCheck(healthContext([KEY]))

    assert.equal(result.healthy, false)
    assert.equal(result.score, 50, 'one of two checks passed')
    const check = result.checks.find((c) => c.name === 'provisioningKey:CONNECTOR_GRP/SJC Connector Key')
    assert.ok(check)
    assert.equal(check.passed, false)
    assert.match(String(check.message), /does not exist in the tenant/)
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys healthCheck: a tenant without the v2 cert endpoint is still reachable', async () => {
  const { calls, restore } = recordFetch([TOKEN, notFound(), zpaList([]), zpaList([LIVE])])
  try {
    const result = await healthCheck(healthContext([KEY]))

    assert.equal(result.healthy, true, 'the App Connector group fallback probe answered')
    assert.ok(
      calls[2].url.includes('/appConnectorGroup'),
      `expected the fallback probe, got ${calls[2].url}`,
    )
    const check = result.checks.find((c) => c.name === 'provisioningKey:CONNECTOR_GRP/SJC Connector Key')
    assert.ok(check)
    assert.equal(check.passed, true)
  } finally {
    restore()
  }
})

test('zpa-provisioning-keys healthCheck: does not look for keys when the tenant is unreachable', async () => {
  const { calls, restore } = recordFetch([TOKEN, serverError(), serverError()])
  try {
    const result = await healthCheck(healthContext([KEY]))

    assert.equal(result.healthy, false)
    assert.equal(
      result.checks.some((c) => c.name.startsWith('provisioningKey:')),
      false,
      'an unreadable tenant must not be reported as the key being absent',
    )
    assert.equal(calls.length, 3, 'both probes failed — nothing further should be read')
  } finally {
    restore()
  }
})

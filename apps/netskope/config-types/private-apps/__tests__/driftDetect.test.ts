// driftDetect for private-apps.
//
// The shared contract covers the refusals, the "deleted in the tenant" diff and
// the unreadable-tenant rule. What is specific here: an app repointed at a
// different internal host, and a port list widened in the console — both are
// exposure changes, and the port comparison has to normalise Netskope's
// comma-joined port strings before it can see them.
//
// NOTE: the publisher list and the clientless / self-signed-cert toggles are
// deliberately not asserted. The handler does not diff them, so an app moved to
// a different publisher, or one switched to trusting self-signed certificates,
// reports as in sync — see the report accompanying these tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import { driftContext, item, npaList, routeFetch } from '../../../lib/__tests__/fakeNetskope'
import { registerDriftContract } from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/steering\/apps\/private/
const APP = item('veltrix-alpha', {
  app_name: 'veltrix-alpha',
  host: 'crm.internal',
  tcp_ports: '443,8443',
  publishers: 'pub-east',
})

registerDriftContract({
  label: 'private-apps',
  handler: driftDetect,
  basePath: '/steering/apps/private',
  listKey: 'private_apps',
  items: [APP],
  inSync: [
    { app_id: '4102', app_name: 'veltrix-alpha', host: 'crm.internal', protocols: [{ type: 'tcp', port: '443,8443' }] },
  ],
  missingField: 'veltrix-alpha',
})

test('private-apps driftDetect: reports an app repointed at a different internal host', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('private_apps', [
        { app_id: '4102', app_name: 'veltrix-alpha', host: 'finance-db.internal', protocols: [{ type: 'tcp', port: '443,8443' }] },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([APP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.host')
    assert.ok(diff, `expected a host diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'crm.internal')
    assert.equal(diff.actual, 'finance-db.internal')
  } finally {
    restore()
  }
})

test('private-apps driftDetect: reports a port opened in the console', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('private_apps', [
        { app_id: '4102', app_name: 'veltrix-alpha', host: 'crm.internal', protocols: [{ type: 'tcp', port: '443,8443,22' }] },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([APP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'veltrix-alpha.protocols')
    assert.ok(diff, `expected a protocols diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /22/)
  } finally {
    restore()
  }
})

test('private-apps driftDetect: treats a reordered port string as unchanged', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('private_apps', [
        { app_id: '4102', app_name: 'veltrix-alpha', host: 'crm.internal', protocols: [{ type: 'tcp', port: '8443, 443' }] },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([APP]))

    assert.equal(result.hasDrift, false, `order and spacing are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('private-apps driftDetect: matches an app the tenant returns under `name`', async () => {
  const { restore } = routeFetch([
    {
      url: BASE_RE,
      method: 'GET',
      respond: npaList('private_apps', [
        { id: '4102', name: 'veltrix-alpha', host: 'crm.internal', protocols: [{ type: 'tcp', port: '443,8443' }] },
      ]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([APP]))

    assert.equal(result.hasDrift, false, 'the alternate identity field must not read as a deleted app')
  } finally {
    restore()
  }
})

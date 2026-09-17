// deploy for npa-local-broker-config.
//
// A SINGLETON: one tenant-wide hostname applied to every local broker, read from
// one endpoint and written back to the same one. There is no collection, no
// matching and no create/update split — what matters is that the prior hostname
// is captured from the LIVE tenant before the write, and that an unreadable
// endpoint stops the deploy rather than being read as "not configured".

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  BASE_URL,
  bodyOf,
  deployContext,
  forbidden,
  item,
  npaData,
  ok,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import { registerDeployGuardContract } from '../../../lib/__tests__/netskopeContracts'

const BASE = '/infrastructure/lbrokers/brokerconfig'
const BASE_RE = /\/infrastructure\/lbrokers\/brokerconfig/

const config = (hostname: string) => item('broker config', { hostname })

registerDeployGuardContract({
  label: 'npa-local-broker-config',
  handler: deploy,
  items: [config('lbr.acme.test')],
  listPath: BASE,
  singleton: true,
})

test('npa-local-broker-config deploy: reads the live config, then writes the declared hostname', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ hostname: 'legacy-lbr.acme.test' }) },
    { url: BASE_RE, method: 'PUT', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([config('lbr.acme.test')]))

    assert.equal(result.success, true, result.message)
    assert.equal(calls.length, 2, 'one read, one write')
    assert.equal(calls[0].method, 'GET', 'the prior hostname must be captured BEFORE the write')
    assert.equal(calls[1].method, 'PUT')
    assert.equal(calls[1].url, `${BASE_URL}${BASE}`)
    assert.deepEqual(bodyOf(calls[1]), { hostname: 'lbr.acme.test' })
  } finally {
    restore()
  }
})

test('npa-local-broker-config deploy: records the LIVE prior hostname, not the one it is writing', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ hostname: 'legacy-lbr.acme.test' }) },
    { url: BASE_RE, method: 'PUT', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([config('lbr.acme.test')]))

    assert.deepEqual(
      result.rollbackData,
      { priorHostname: 'legacy-lbr.acme.test' },
      'rollback restores what was there, not what was wanted',
    )
  } finally {
    restore()
  }
})

test('npa-local-broker-config deploy: records an empty prior when the tenant had no hostname set', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({}) },
    { url: BASE_RE, method: 'PUT', respond: ok() },
  ])
  try {
    const result = await deploy(deployContext([config('lbr.acme.test')]))

    assert.equal(result.success, true, result.message)
    assert.deepEqual(result.rollbackData, { priorHostname: '' })
  } finally {
    restore()
  }
})

test('npa-local-broker-config deploy: returns the prior hostname even when the write is rejected', async () => {
  // A PUT that half-applied, or one whose failure the tenant reported after
  // acting, still needs the prior value on record. A failure path that dropped
  // rollbackData would throw the only copy away.
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ hostname: 'legacy-lbr.acme.test' }) },
    { url: BASE_RE, method: 'PUT', respond: forbidden('not authorized to change the broker config') },
  ])
  try {
    const result = await deploy(deployContext([config('lbr.acme.test')]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /not authorized/)
    assert.deepEqual(result.rollbackData, { priorHostname: 'legacy-lbr.acme.test' })
  } finally {
    restore()
  }
})

test('npa-local-broker-config deploy: applies only the first item when the canvas holds several', async () => {
  // The endpoint is tenant-wide, so a second item is not a second object — it is
  // a second opinion about the same one, and validate already warns about it.
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: npaData({ hostname: 'legacy-lbr.acme.test' }) },
    { url: BASE_RE, method: 'PUT', respond: ok() },
  ])
  try {
    await deploy(deployContext([config('first.acme.test'), config('second.acme.test')]))

    assert.equal(writeCalls(calls).length, 1)
    assert.deepEqual(bodyOf(writeCalls(calls)[0]), { hostname: 'first.acme.test' })
  } finally {
    restore()
  }
})

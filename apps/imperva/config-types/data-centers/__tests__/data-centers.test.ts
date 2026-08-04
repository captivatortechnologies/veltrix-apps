import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import { dataCentersFromResponse, findDataCenter, findServer, parseServers, readDataCenterFields, toBool } from '../_shared'

/**
 * The deploy/rollback/drift handlers call the Cloud WAF v1 API via fetch, which is
 * impractical to mock here. Tests cover validate.ts and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  siteId: '123456',
  name: 'Primary Pool',
  isContentOnly: 'false',
  isEnabled: 'true',
  servers: JSON.stringify([{ address: '203.0.113.10', isStandby: false, isEnabled: true }, { address: '203.0.113.11', isStandby: true, isEnabled: true }]),
}

// --- validate ---------------------------------------------------------------

test('validate accepts a good data center', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing / non-numeric site ID', async () => {
  assert.ok((await validate(ctxOf([{ ...good, siteId: '' }]))).errors.some((e) => e.code === 'EMPTY_SITE_ID'))
  assert.ok((await validate(ctxOf([{ ...good, siteId: 'x' }]))).errors.some((e) => e.code === 'INVALID_SITE_ID'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate requires at least one server', async () => {
  const res = await validate(ctxOf([{ ...good, servers: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SERVERS'))
})

test('validate rejects a server with no address', async () => {
  const res = await validate(ctxOf([{ ...good, servers: JSON.stringify([{ address: '' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SERVER_ADDRESS'))
})

test('validate rejects duplicate server addresses within one data center', async () => {
  const res = await validate(ctxOf([{ ...good, servers: JSON.stringify([{ address: '203.0.113.10' }, { address: '203.0.113.10' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_SERVER_ADDRESS'))
})

test('validate warns when every server is disabled', async () => {
  const res = await validate(ctxOf([{ ...good, servers: JSON.stringify([{ address: '203.0.113.10', isEnabled: false }]) }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'ALL_SERVERS_DISABLED'))
})

test('validate warns on a duplicate (site, name) pair and allows the same name on another site', async () => {
  assert.ok((await validate(ctxOf([good, { ...good, name: good.name.toLowerCase() }]))).warnings.some((w) => w.code === 'DUPLICATE_NAME'))
  assert.ok(!(await validate(ctxOf([good, { ...good, siteId: '999' }]))).warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('parseServers accepts a JSON string or array, dropping entries with no address', () => {
  assert.deepEqual(parseServers('[{"address":"1.2.3.4","isStandby":true,"isEnabled":false}]'), [{ address: '1.2.3.4', isStandby: true, isEnabled: false }])
  assert.deepEqual(parseServers([{ address: '1.2.3.4' }]), [{ address: '1.2.3.4', isStandby: false, isEnabled: true }])
  assert.deepEqual(parseServers([{ address: '' }]), [])
  assert.deepEqual(parseServers('not json'), [])
  assert.deepEqual(parseServers(undefined), [])
})

test('toBool normalizes booleans and true/false strings, falling back otherwise', () => {
  assert.equal(toBool(true, false), true)
  assert.equal(toBool('true', false), true)
  assert.equal(toBool('false', true), false)
  assert.equal(toBool('bogus', true), true)
  assert.equal(toBool(undefined, false), false)
})

test('readDataCenterFields normalizes an item into a data center shape', () => {
  const fields = readDataCenterFields(good)
  assert.equal(fields.siteId, '123456')
  assert.equal(fields.name, 'Primary Pool')
  assert.equal(fields.isContentOnly, false)
  assert.equal(fields.isEnabled, true)
  assert.equal(fields.servers.length, 2)
  assert.equal(fields.servers[1].isStandby, true)
})

test('dataCentersFromResponse + findDataCenter + findServer navigate the list envelope', () => {
  const response = {
    res: 0,
    DCs: [
      { id: '1', name: 'Primary Pool', enabled: 'true', contentOnly: 'false', servers: [{ id: '10', address: '203.0.113.10', enabled: 'true', isStandBy: 'false' }] },
    ],
  }
  const dcs = dataCentersFromResponse(response)
  assert.equal(dcs.length, 1)
  const dc = findDataCenter(dcs, 'primary pool')
  assert.ok(dc)
  assert.equal(findDataCenter(dcs, 'missing'), null)
  const server = findServer(dc!.servers!, '203.0.113.10')
  assert.equal(server?.id, '10')
  assert.equal(findServer(dc!.servers!, '9.9.9.9'), null)
  assert.deepEqual(dataCentersFromResponse(null), [])
})

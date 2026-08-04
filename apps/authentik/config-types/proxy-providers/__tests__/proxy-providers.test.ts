import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  managedFieldsToPatchBody,
  readManagedFields,
  sameManagedFields,
  snapshotManagedFields,
  type AuthentikProxyProvider,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const AUTHZ_FLOW = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
const INVAL_FLOW = 'b2c3d4e5-f6a7-4890-b123-456789abcdef'

const good = {
  name: 'Grafana Proxy',
  authorization_flow: AUTHZ_FLOW,
  invalidation_flow: INVAL_FLOW,
  mode: 'proxy',
  internal_host: 'http://grafana.internal:3000',
  external_host: 'https://grafana.example.com',
  internal_host_ssl_validation: true,
  basic_auth_enabled: false,
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing external_host', async () => {
  const res = await validate(ctxOf([{ ...good, external_host: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EXTERNAL_HOST'))
})

test('validate requires internal_host in proxy mode', async () => {
  const res = await validate(ctxOf([{ ...good, internal_host: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_INTERNAL_HOST'))
})

test('validate does not require internal_host in forward_domain mode', async () => {
  const res = await validate(ctxOf([{ ...good, mode: 'forward_domain', internal_host: '', cookie_domain: 'example.com' }]))
  assert.equal(res.valid, true)
})

test('validate rejects an unknown mode', async () => {
  const res = await validate(ctxOf([{ ...good, mode: 'reverse' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MODE'))
})

test('validate accepts a fully populated provider', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('readManagedFields defaults an invalid mode to proxy', () => {
  const managed = readManagedFields({ ...good, mode: 'bogus' })
  assert.equal(managed.mode, 'proxy')
})

test('buildCreateBody omits internal_host when blank (forwardAuth)', () => {
  const body = buildCreateBody({ ...good, mode: 'forward_domain', internal_host: '', cookie_domain: 'example.com' }) as Record<string, unknown>
  assert.equal('internal_host' in body, false)
  assert.equal(body.cookie_domain, 'example.com')
})

test('snapshotManagedFields reads a live provider', () => {
  const live: AuthentikProxyProvider = {
    pk: 5,
    name: 'Grafana Proxy',
    authorization_flow: AUTHZ_FLOW,
    invalidation_flow: INVAL_FLOW,
    mode: 'proxy',
    internal_host: 'http://grafana.internal:3000',
    external_host: 'https://grafana.example.com',
    internal_host_ssl_validation: true,
    basic_auth_enabled: false,
  }
  const snap = snapshotManagedFields(live)
  assert.equal(snap.mode, 'proxy')
  assert.equal(snap.internalHost, 'http://grafana.internal:3000')
})

test('sameManagedFields detects a changed external_host', () => {
  const expected = readManagedFields(good)
  const actual = snapshotManagedFields({ ...good, external_host: 'https://changed.example.com' } as AuthentikProxyProvider)
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured snapshot', () => {
  const managed = readManagedFields(good)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.equal(body.external_host, 'https://grafana.example.com')
})

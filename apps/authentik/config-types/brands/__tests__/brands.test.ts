import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  managedFieldsToPatchBody,
  readAttributes,
  readManagedFields,
  sameAttributes,
  sameManagedFields,
  snapshotManagedFields,
  UUID_PATTERN,
  type AuthentikBrand,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.domain ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const FLOW_UUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'

const good = {
  domain: 'auth.example.com',
  default: true,
  branding_title: 'Example Corp',
  branding_logo: 'https://example.com/logo.svg',
  branding_favicon: 'https://example.com/favicon.ico',
  flow_authentication: FLOW_UUID,
  attributes: { theme: 'dark' },
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing domain', async () => {
  const res = await validate(ctxOf([{ ...good, domain: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DOMAIN'))
})

test('validate rejects a non-UUID flow reference', async () => {
  const res = await validate(ctxOf([{ ...good, flow_authentication: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FLOW_UUID'))
})

test('validate warns on a duplicate domain', async () => {
  const res = await validate(ctxOf([good, { ...good, default: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_DOMAIN'))
})

test('validate warns when more than one brand is marked default', async () => {
  const res = await validate(ctxOf([good, { ...good, domain: 'other.example.com', default: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MULTIPLE_DEFAULTS'))
})

test('validate accepts a fully populated brand', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('UUID_PATTERN matches a v4-shaped UUID', () => {
  assert.equal(UUID_PATTERN.test(FLOW_UUID), true)
  assert.equal(UUID_PATTERN.test('nope'), false)
})

test('readAttributes accepts an object', () => {
  assert.deepEqual(readAttributes({ theme: 'dark' }), { theme: 'dark' })
})

test('sameAttributes compares keys and values', () => {
  assert.equal(sameAttributes({ a: '1' }, { a: '1' }), true)
  assert.equal(sameAttributes({ a: '1' }, { a: '2' }), false)
})

test('buildCreateBody omits optional flow overrides when blank', () => {
  const body = buildCreateBody({ ...good, flow_invalidation: '', flow_recovery: '' }) as Record<string, unknown>
  assert.equal('flow_invalidation' in body, false)
  assert.equal('flow_recovery' in body, false)
  assert.equal(body.flow_authentication, FLOW_UUID)
})

test('snapshotManagedFields reads a live brand', () => {
  const live: AuthentikBrand = {
    brand_uuid: 'uuid-1',
    domain: 'auth.example.com',
    default: true,
    branding_title: 'Example Corp',
    attributes: { theme: 'dark' },
  }
  const snap = snapshotManagedFields(live)
  assert.equal(snap.brandingTitle, 'Example Corp')
  assert.deepEqual(snap.attributes, { theme: 'dark' })
})

test('sameManagedFields detects a changed branding_title', () => {
  const expected = readManagedFields(good)
  const actual = snapshotManagedFields({ ...good, branding_title: 'Changed Corp' } as AuthentikBrand)
  assert.equal(sameManagedFields(expected, actual), false)
})

test('managedFieldsToPatchBody round-trips a captured snapshot', () => {
  const managed = readManagedFields(good)
  const body = managedFieldsToPatchBody(managed) as Record<string, unknown>
  assert.equal(body.domain, 'auth.example.com')
})

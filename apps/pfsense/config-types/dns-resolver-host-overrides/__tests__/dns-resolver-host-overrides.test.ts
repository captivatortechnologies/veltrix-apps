import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, hostOverrideKey, isValidHostLabel, isValidOverrideDomain, toHostOverrideBody, snapshotHostOverride, MAX_DESCRIPTION_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `item-${i}`, name: `override-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const validOverride = { host: 'nas', domain: 'internal.example.com', ip: ['10.0.0.10'], descr: 'File server' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate allows a blank host with a warning (overrides the bare domain)', async () => {
  const res = await validate(ctxOf([{ ...validOverride, host: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'BLANK_HOST_OVERRIDES_DOMAIN'))
})

test('validate rejects a malformed host label', async () => {
  const res = await validate(ctxOf([{ ...validOverride, host: 'not a host!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_HOST'))
})

test('validate requires a domain', async () => {
  const res = await validate(ctxOf([{ ...validOverride, domain: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DOMAIN'))
})

test('validate rejects a duplicate host+domain (case-insensitive)', async () => {
  const res = await validate(ctxOf([validOverride, { ...validOverride, host: 'NAS', domain: 'INTERNAL.EXAMPLE.COM' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_HOST_DOMAIN'))
})

test('validate allows the same domain with two DIFFERENT hosts', async () => {
  const res = await validate(ctxOf([validOverride, { ...validOverride, host: 'nas2' }]))
  assert.equal(res.errors.some((e) => e.code === 'DUPLICATE_HOST_DOMAIN'), false)
})

test('validate requires at least one IP', async () => {
  const res = await validate(ctxOf([{ ...validOverride, ip: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_IP'))
})

test('validate rejects a malformed IP entry', async () => {
  const res = await validate(ctxOf([{ ...validOverride, ip: ['not-an-ip'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IP'))
})

test('validate accepts a well-formed host override', async () => {
  const res = await validate(ctxOf([validOverride]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a description over the limit', async () => {
  const res = await validate(ctxOf([{ ...validOverride, descr: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('hostOverrideKey composes host+domain, lowercased', () => {
  assert.equal(hostOverrideKey('NAS', 'Internal.Example.COM'), 'nas.internal.example.com')
  assert.equal(hostOverrideKey('', 'Internal.Example.COM'), '.internal.example.com')
})

test('isValidHostLabel accepts blank and a hostname label, rejects invalid chars', () => {
  assert.equal(isValidHostLabel(''), true)
  assert.equal(isValidHostLabel('nas-01'), true)
  assert.equal(isValidHostLabel('not valid!'), false)
})

test('isValidOverrideDomain accepts a multi-label domain', () => {
  assert.equal(isValidOverrideDomain('internal.example.com'), true)
  assert.equal(isValidOverrideDomain('not a domain!'), false)
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([validOverride, validOverride]))
  assert.equal(specs.length, 2)
})

test('toHostOverrideBody always sends an empty aliases array', () => {
  const spec = specFromItem({ id: 'i', name: 'x', fields: validOverride })
  assert.deepEqual(toHostOverrideBody(spec).aliases, [])
})

test('snapshotHostOverride never includes id', () => {
  const snap = snapshotHostOverride({ id: 2, host: 'nas', domain: 'internal.example.com', ip: ['10.0.0.10'] }) as Record<string, unknown>
  assert.equal('id' in snap, false)
  assert.equal(snap.host, 'nas')
})

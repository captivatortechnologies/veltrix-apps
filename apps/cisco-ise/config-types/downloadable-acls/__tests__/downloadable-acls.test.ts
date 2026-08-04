import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toDownloadableAclBody, normalizeDaclType, MAX_NAME_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'PERMIT_ALL_IPV4_TRAFFIC', dacl: 'permit ip any any', dacl_type: 'IPV4' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects empty ACL content', async () => {
  const res = await validate(ctxOf([{ ...good, dacl: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DACL_CONTENT'))
})

test('validate rejects an invalid ACL type', async () => {
  const res = await validate(ctxOf([{ ...good, dacl_type: 'IPX' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DACL_TYPE'))
})

test('validate rejects a name over the ERS length limit', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'a'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a well-formed DACL', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('normalizeDaclType defaults unknown values to IPV4', () => {
  assert.equal(normalizeDaclType('ipv6'), 'IPV6')
  assert.equal(normalizeDaclType('nonsense'), 'IPV4')
  assert.equal(normalizeDaclType(undefined), 'IPV4')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([good]))
  assert.equal(specs.length, 1)
  assert.equal(specs[0].name, 'PERMIT_ALL_IPV4_TRAFFIC')
})

test('toDownloadableAclBody carries every field through', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: good })
  const body = toDownloadableAclBody(spec)
  assert.equal(body.dacl, 'permit ip any any')
  assert.equal(body.daclType, 'IPV4')
})

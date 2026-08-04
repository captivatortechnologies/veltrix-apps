import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { attributeIdentity, buildAttributeBody, findAttributeByShortName, findAttributeTypeByName, listFrom } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the BeyondInsight REST API via node:https inside
 * beyondtrustApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (identity, list-unwrap, body-build), which are
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.shortName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { attributeTypeName: 'Environment', shortName: 'prod', longName: 'Production', description: 'Production systems' }

test('validate rejects a missing attribute type', async () => {
  const res = await validate(ctxOf([{ ...good, attributeTypeName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ATTRIBUTE_TYPE'))
})

test('validate rejects a missing short name', async () => {
  const res = await validate(ctxOf([{ ...good, shortName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SHORT_NAME'))
})

test('validate rejects a missing long name', async () => {
  const res = await validate(ctxOf([{ ...good, longName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LONG_NAME'))
})

test('validate rejects over-long short/long names and description', async () => {
  const overShort = await validate(ctxOf([{ ...good, shortName: 'a'.repeat(65) }]))
  assert.ok(overShort.errors.some((e) => e.code === 'SHORT_NAME_TOO_LONG'))

  const overLong = await validate(ctxOf([{ ...good, longName: 'a'.repeat(65) }]))
  assert.ok(overLong.errors.some((e) => e.code === 'LONG_NAME_TOO_LONG'))

  const overDesc = await validate(ctxOf([{ ...good, description: 'a'.repeat(256) }]))
  assert.ok(overDesc.errors.some((e) => e.code === 'DESCRIPTION_TOO_LONG'))
})

test('validate warns on a duplicate (attribute type, short name) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, longName: 'Prod (copy)' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ATTRIBUTE'))
})

test('validate treats same short name in a different attribute type as distinct', async () => {
  const res = await validate(ctxOf([good, { ...good, attributeTypeName: 'Department' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildAttributeBody always sends a null ParentAttributeID and omits a blank description', () => {
  const body = buildAttributeBody({ shortName: 'prod', longName: 'Production' })
  assert.deepEqual(body, { ShortName: 'prod', LongName: 'Production', ParentAttributeID: null })

  const full = buildAttributeBody({ shortName: 'prod', longName: 'Production', description: 'Production systems' })
  assert.deepEqual(full, { ShortName: 'prod', LongName: 'Production', Description: 'Production systems', ParentAttributeID: null })
})

test('listFrom unwraps arrays and paginated containers', () => {
  assert.equal(listFrom<{ a: number }>([{ a: 1 }]).length, 1)
  assert.equal(listFrom<{ a: number }>({ Data: [{ a: 1 }, { a: 2 }] }).length, 2)
  assert.equal(listFrom<unknown>(null).length, 0)
})

test('findAttributeTypeByName matches case-insensitively', () => {
  const live = [{ AttributeTypeID: 3, Name: 'Environment' }]
  assert.equal(findAttributeTypeByName(live, 'ENVIRONMENT')?.AttributeTypeID, 3)
  assert.equal(findAttributeTypeByName(live, 'nope'), null)
})

test('findAttributeByShortName matches case-insensitively', () => {
  const live = [{ AttributeID: 9, ShortName: 'prod' }]
  assert.equal(findAttributeByShortName(live, 'PROD')?.AttributeID, 9)
  assert.equal(findAttributeByShortName(live, 'nope'), null)
})

test('attributeIdentity is stable across casing', () => {
  assert.equal(attributeIdentity('Prod'), attributeIdentity('prod'))
  assert.notEqual(attributeIdentity('prod'), attributeIdentity('staging'))
})

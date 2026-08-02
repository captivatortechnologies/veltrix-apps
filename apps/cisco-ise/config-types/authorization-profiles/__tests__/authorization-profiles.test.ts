import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  specFromItem,
  extractSpecs,
  toAuthorizationProfileBody,
  parseAdvancedAttributes,
  normalizeAccessType,
  AUTHZ_PROFILE_TYPE,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Contractor-Access', access_type: 'ACCESS_ACCEPT', dacl_name: 'PERMIT_ALL_IPV4_TRAFFIC' }

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

test('validate rejects an invalid access type', async () => {
  const res = await validate(ctxOf([{ ...good, access_type: 'MAYBE' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACCESS_TYPE'))
})

test('validate rejects a VLAN tag outside 0-31', async () => {
  const res = await validate(ctxOf([{ ...good, vlan_name: 'employees', vlan_tag: 99 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VLAN_TAG'))
})

test('validate warns on a VLAN tag with no VLAN name', async () => {
  const res = await validate(ctxOf([{ ...good, vlan_tag: 5 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'VLAN_TAG_WITHOUT_NAME'))
})

test('validate rejects malformed advanced_attributes JSON', async () => {
  const res = await validate(ctxOf([{ ...good, advanced_attributes: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ADVANCED_ATTRIBUTES_JSON'))
})

test('validate rejects an advanced attribute with no left-hand side', async () => {
  const res = await validate(ctxOf([{ ...good, advanced_attributes: '[{"rightHandSideAttributeValue":"3600"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'ADVANCED_ATTRIBUTE_MISSING_LHS'))
})

test('validate warns on a duplicate profile name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a well-formed profile', async () => {
  const res = await validate(ctxOf([{ ...good, vlan_name: 'employees', vlan_tag: 1 }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('normalizeAccessType defaults unknown values to ACCESS_ACCEPT', () => {
  assert.equal(normalizeAccessType('access_reject'), 'ACCESS_REJECT')
  assert.equal(normalizeAccessType('nonsense'), 'ACCESS_ACCEPT')
  assert.equal(normalizeAccessType(undefined), 'ACCESS_ACCEPT')
})

test('parseAdvancedAttributes coerces field values to strings', () => {
  const { attributes, error } = parseAdvancedAttributes('[{"leftHandSideDictionaryAttribute":"Radius:Session-Timeout","rightHandSideAttributeValue":3600}]')
  assert.equal(error, undefined)
  assert.equal(attributes.length, 1)
  assert.equal(attributes[0].rightHandSideAttributeValue, '3600')
})

test('parseAdvancedAttributes treats blank as an empty list', () => {
  assert.deepEqual(parseAdvancedAttributes('').attributes, [])
  assert.deepEqual(parseAdvancedAttributes(null).attributes, [])
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([good]))
  assert.equal(specs.length, 1)
  assert.equal(specs[0].name, 'Contractor-Access')
})

test('toAuthorizationProfileBody always sends authzProfileType SWITCH and omits blank optionals', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: good })
  const body = toAuthorizationProfileBody(spec)
  assert.equal(body.authzProfileType, AUTHZ_PROFILE_TYPE)
  assert.equal(body.daclName, 'PERMIT_ALL_IPV4_TRAFFIC')
  assert.equal(body.vlan, undefined)
  assert.equal(body.acl, undefined)
})

test('toAuthorizationProfileBody includes vlan only when a VLAN name is set, defaulting the tag to 1', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { ...good, vlan_name: 'employees' } })
  const body = toAuthorizationProfileBody(spec)
  assert.deepEqual(body.vlan, { nameID: 'employees', tagID: 1 })
})

test('toAuthorizationProfileBody honours an explicit VLAN tag', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: { ...good, vlan_name: 'employees', vlan_tag: 7 } })
  const body = toAuthorizationProfileBody(spec)
  assert.deepEqual(body.vlan, { nameID: 'employees', tagID: 7 })
})

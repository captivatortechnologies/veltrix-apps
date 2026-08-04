import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { specFromItem, extractSpecs, toSgaclBody, normalizeIpVersion, normalizeAclContent, MAX_NAME_LENGTH } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Permit_Web', acl_content: 'permit tcp dst eq 443', ip_version: 'IP_AGNOSTIC' }

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

test('validate rejects a name that does not start with a letter', async () => {
  const res = await validate(ctxOf([{ ...good, name: '1Permit' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a name over the length limit', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'a'.repeat(MAX_NAME_LENGTH + 1) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects empty ACL content', async () => {
  const res = await validate(ctxOf([{ ...good, acl_content: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACL_CONTENT'))
})

test('validate rejects an invalid IP version', async () => {
  const res = await validate(ctxOf([{ ...good, ip_version: 'IPX' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IP_VERSION'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a well-formed SGACL', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('normalizeIpVersion defaults unknown values to IP_AGNOSTIC', () => {
  assert.equal(normalizeIpVersion('ipv4'), 'IPV4')
  assert.equal(normalizeIpVersion('nonsense'), 'IP_AGNOSTIC')
})

test('normalizeAclContent joins non-blank trimmed lines with newlines', () => {
  assert.equal(normalizeAclContent(' permit tcp \n\n deny ip \n'), 'permit tcp\ndeny ip')
  assert.equal(normalizeAclContent(undefined), '')
})

test('extractSpecs maps every item', () => {
  const specs = extractSpecs(toItems([good]))
  assert.equal(specs.length, 1)
  assert.equal(specs[0].name, 'Permit_Web')
})

test('toSgaclBody sends the ACL content under the aclcontent wire key', () => {
  const spec = specFromItem({ id: 'i0', name: 'x', fields: good })
  const body = toSgaclBody(spec)
  assert.equal(body.aclcontent, 'permit tcp dst eq 443')
  assert.equal(body.ipVersion, 'IP_AGNOSTIC')
})

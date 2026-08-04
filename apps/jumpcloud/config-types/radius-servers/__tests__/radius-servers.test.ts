import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractRadiusServerSpecs,
  toTagList,
  normalizeBool,
  buildRadiusServerCreateBody,
  buildRadiusServerUpdateBody,
  findRadiusServerByName,
  priorFieldsOf,
  type JumpCloudRadiusServer,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = { name: 'HQ Wireless', networkSourceIp: '203.0.113.10', sharedSecret: 's3cret', mfa: 'ENABLED', authIdp: 'JUMPCLOUD', caSource: 'NONE' }

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing network source ip', async () => {
  const res = await validate(ctxOf([{ ...good, networkSourceIp: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NETWORK_SOURCE'))
})

test('validate rejects a missing shared secret', async () => {
  const res = await validate(ctxOf([{ ...good, sharedSecret: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SECRET'))
})

test('validate rejects invalid enum values', async () => {
  const res = await validate(ctxOf([{ ...good, mfa: 'MAYBE' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MFA'))
})

test('validate warns when BYOC has no CA cert', async () => {
  const res = await validate(ctxOf([{ ...good, caSource: 'BYOC', caCert: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_CA_CERT'))
})

test('validate errors on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ----------------------------------------------------------

test('toTagList and normalizeBool behave as expected', () => {
  assert.deepEqual(toTagList('a, b\na'), ['a', 'b'])
  assert.equal(normalizeBool(undefined, true), true)
  assert.equal(normalizeBool('false', true), false)
})

test('extractRadiusServerSpecs trims fields and defaults enums', () => {
  const [spec] = extractRadiusServerSpecs(canvasOf([{ name: ' HQ ', networkSourceIp: '1.2.3.4', sharedSecret: 's' }]))
  assert.equal(spec.name, 'HQ')
  assert.equal(spec.mfa, 'DISABLED')
  assert.equal(spec.authIdp, 'JUMPCLOUD')
  assert.equal(spec.itemId, 'i0')
})

test('create body includes authIdp + tagNames; update body includes tags (no authIdp)', () => {
  const spec = {
    name: 'HQ', networkSourceIp: '1.2.3.4', sharedSecret: 's', authIdp: 'AZURE', mfa: 'ENABLED',
    userLockoutAction: '', userPasswordExpirationAction: '', userPasswordEnabled: true, userCertEnabled: false,
    deviceCertEnabled: false, caCert: '', requireTlsAuth: false, radsecEnabled: false, requireRadsec: false,
    caSource: 'NONE', tags: ['t1'],
  }
  const createBody = buildRadiusServerCreateBody(spec)
  assert.equal(createBody.authIdp, 'AZURE')
  assert.deepEqual(createBody.tagNames, ['t1'])
  assert.equal('tags' in createBody, false)

  const updateBody = buildRadiusServerUpdateBody(spec)
  assert.deepEqual(updateBody.tags, ['t1'])
  assert.equal('authIdp' in updateBody, false)
})

test('findRadiusServerByName matches case-insensitively', () => {
  const servers: JumpCloudRadiusServer[] = [{ _id: 'a', name: 'HQ Wireless' }]
  assert.equal(findRadiusServerByName(servers, 'hq wireless')?._id, 'a')
  assert.equal(findRadiusServerByName(servers, 'MISSING'), null)
})

test('priorFieldsOf captures the true prior shared secret (JumpCloud returns it on GET)', () => {
  const prior = priorFieldsOf({ _id: 'a', name: 'HQ', sharedSecret: 'live-secret', tags: ['x'] })
  assert.equal(prior.sharedSecret, 'live-secret')
  assert.deepEqual(prior.tags, ['x'])
})

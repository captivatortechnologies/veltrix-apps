import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildAddBody, buildEditBody, findProfile, profilesFromReply, isValidModulesJson, normalizeName } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cortex XDR REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (identity matching + body building) — both network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Standard Malware Protection',
  profile_type: 'malware',
  platform: 'windows',
  modules: '{"wildfire":{"enabled":true}}',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed prevention profile', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing profile_type', async () => {
  const res = await validate(ctxOf([{ ...good, profile_type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROFILE_TYPE'))
})

test('validate warns on an unrecognized profile_type', async () => {
  const res = await validate(ctxOf([{ ...good, profile_type: 'something_new' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNRECOGNIZED_PROFILE_TYPE'))
})

test('validate rejects a missing platform', async () => {
  const res = await validate(ctxOf([{ ...good, platform: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PLATFORM'))
})

test('validate rejects invalid modules JSON', async () => {
  const res = await validate(ctxOf([{ ...good, modules: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MODULES_JSON'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('buildAddBody parses modules JSON and omits blank description', () => {
  const body = buildAddBody(good)
  assert.deepEqual(body.modules, { wildfire: { enabled: true } })
  assert.equal('description' in body, false)
})

test('buildAddBody throws when modules is blank', () => {
  assert.throws(() => buildAddBody({ ...good, modules: '' }))
})

test('buildEditBody targets the given profile id', () => {
  const body = buildEditBody(42, good)
  assert.equal(body.profile_id, 42)
  assert.equal(body.update_data.name, good.name)
})

test('isValidModulesJson rejects blank and malformed JSON', () => {
  assert.equal(isValidModulesJson(''), false)
  assert.equal(isValidModulesJson('{"a":1}'), true)
  assert.equal(isValidModulesJson('[1,2]'), false)
})

test('findProfile matches case-insensitively on name', () => {
  const live = [{ name: 'STANDARD MALWARE PROTECTION', id: 9 }]
  const match = findProfile(live, 'standard malware protection')
  assert.ok(match)
  assert.equal(match?.id, 9)
})

test('profilesFromReply unwraps both the array and { profiles } shapes', () => {
  assert.equal(profilesFromReply([{ name: 'a' }]).length, 1)
  assert.equal(profilesFromReply({ profiles: [{ name: 'b' }, { name: 'c' }] }).length, 2)
  assert.equal(profilesFromReply(null).length, 0)
})

test('normalizeName trims and lowercases', () => {
  assert.equal(normalizeName('  Standard Malware Protection  '), 'standard malware protection')
})

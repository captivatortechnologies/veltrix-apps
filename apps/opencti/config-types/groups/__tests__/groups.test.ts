import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildGroupInput, buildGroupPatch, findGroup, groupsFromList, normalizeBool } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus on
 * validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Analysts', description: 'Tier-1 analysts', default_assignation: true, auto_new_marking: false }

test('validate rejects a missing group name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate group name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'dup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good group and a name-only group', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const bare = await validate(ctxOf([{ name: 'Admins' }]))
  assert.equal(bare.valid, true)
  assert.equal(bare.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('normalizeBool coerces checkbox-ish values', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool(''), undefined)
  assert.equal(normalizeBool(undefined), undefined)
})

test('buildGroupInput keeps name + set fields, omits blanks, and always sends group_confidence_level (required by the schema)', () => {
  const input = buildGroupInput({ name: 'Analysts', description: '', default_assignation: true })
  assert.deepEqual(input, {
    name: 'Analysts',
    default_assignation: true,
    group_confidence_level: { max_confidence: null, overrides: [] },
  })

  const full = buildGroupInput({ ...good, confidence_level_max: 75 })
  assert.equal(full.description, 'Tier-1 analysts')
  assert.equal(full.default_assignation, true)
  assert.equal(full.auto_new_marking, false)
  assert.deepEqual(full.group_confidence_level, { max_confidence: 75, overrides: [] })
})

test('buildGroupPatch sends booleans natively (EditInput.value is [Any], not [String]) and never patches the identity', () => {
  const patch = buildGroupPatch(good)
  assert.ok(patch.every((p) => p.key !== 'name'))
  const dflt = patch.find((p) => p.key === 'default_assignation')
  assert.deepEqual(dflt?.value, [true])
  const auto = patch.find((p) => p.key === 'auto_new_marking')
  assert.deepEqual(auto?.value, [false])
  const confidence = patch.find((p) => p.key === 'group_confidence_level')
  assert.deepEqual(confidence?.value, [{ max_confidence: null, overrides: [] }])
})

test('groupsFromList unwraps the edges/node connection', () => {
  const list = groupsFromList({
    groups: { edges: [{ node: { id: '1', name: 'Analysts' } }, { node: { id: '2', name: 'Admins' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findGroup(list, 'analysts')?.id, '1')
})

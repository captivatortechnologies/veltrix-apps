import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import {
  contentFromResponse,
  findPolicy,
  latestVersion,
  parseMatchRules,
  policyPath,
  policyVersionPath,
  policyVersionsPath,
  readPolicyFields,
  sameMatchRules,
} from '../_shared'

/**
 * The deploy/rollback/drift handlers apply over the Cloudlets API via fetch
 * inside akamaiApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (network-free). The EdgeGrid
 * signer itself is covered in lib/__tests__/akamaiApi.test.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodPolicy = { name: 'block_bad_bots', cloudletType: 'ER', groupId: 12345, description: 'redirect legacy paths', matchRules: '[{"name":"r1","type":"erMatchRule"}]' }

// --- validate ---------------------------------------------------------------

test('validate accepts a good policy', async () => {
  const res = await validate(ctxOf([goodPolicy]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...goodPolicy, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name with invalid characters', async () => {
  const res = await validate(ctxOf([{ ...goodPolicy, name: 'not valid!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unknown cloudlet type', async () => {
  const res = await validate(ctxOf([{ ...goodPolicy, cloudletType: 'ZZ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CLOUDLET_TYPE'))
})

test('validate rejects a non-positive group id', async () => {
  const res = await validate(ctxOf([{ ...goodPolicy, groupId: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GROUP_ID'))
})

test('validate rejects malformed match rules JSON', async () => {
  const res = await validate(ctxOf([{ ...goodPolicy, matchRules: '{not an array' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MATCH_RULES_JSON'))
})

test('validate warns on empty match rules', async () => {
  const res = await validate(ctxOf([{ ...goodPolicy, matchRules: '[]' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_MATCH_RULES'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([goodPolicy, { ...goodPolicy }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('contentFromResponse unwraps the { content: [...] } page envelope', () => {
  assert.deepEqual(contentFromResponse({ content: [{ id: 1 }] }), [{ id: 1 }])
  assert.deepEqual(contentFromResponse([{ id: 2 }]), [{ id: 2 }])
  assert.deepEqual(contentFromResponse(null), [])
})

test('findPolicy matches by name case-insensitively', () => {
  const policies = [{ name: 'Alpha', id: 1 }, { name: 'Beta', id: 2 }]
  assert.equal(findPolicy(policies, 'beta')?.id, 2)
  assert.equal(findPolicy(policies, 'missing'), null)
})

test('latestVersion picks the highest version number', () => {
  assert.equal(latestVersion([{ version: 1 }, { version: 3 }, { version: 2 }])?.version, 3)
  assert.equal(latestVersion([]), null)
})

test('parseMatchRules accepts blank input and JSON arrays', () => {
  assert.deepEqual(parseMatchRules(''), [])
  assert.deepEqual(parseMatchRules('[{"a":1}]'), [{ a: 1 }])
})

test('parseMatchRules throws on malformed JSON and non-array values', () => {
  assert.throws(() => parseMatchRules('{bad'))
  assert.throws(() => parseMatchRules('{"a":1}'))
})

test('sameMatchRules is order-sensitive deep equality', () => {
  assert.equal(sameMatchRules([{ a: 1 }], [{ a: 1 }]), true)
  assert.equal(sameMatchRules([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 1 }]), false)
})

test('readPolicyFields normalizes an item into a create/update field set', () => {
  const f = readPolicyFields(goodPolicy)
  assert.equal(f.name, 'block_bad_bots')
  assert.equal(f.cloudletType, 'ER')
  assert.equal(f.groupId, 12345)
  assert.deepEqual(f.matchRules, [{ name: 'r1', type: 'erMatchRule' }])
})

test('path builders shape the policy/version endpoints', () => {
  assert.equal(policyPath(42), '/cloudlets/v3/policies/42')
  assert.equal(policyVersionsPath(42), '/cloudlets/v3/policies/42/versions')
  assert.equal(policyVersionPath(42, 3), '/cloudlets/v3/policies/42/versions/3')
})

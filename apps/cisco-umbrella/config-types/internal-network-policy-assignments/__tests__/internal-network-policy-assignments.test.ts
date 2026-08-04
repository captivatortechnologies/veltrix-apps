import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { assignmentKey, extractPolicyAssignmentSpecs } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Umbrella Deployments API
 * (plus cross-resource identity/policy lookups), which is impractical to mock
 * here. Tests focus on the pure, network-free pieces: validate.ts and the
 * _shared parsing helpers.
 */
function ctxWith(list: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>): PipelineContext {
  const items = list.map((row, i) => ({ id: row.id ?? `i${i}`, name: row.name ?? String(i), fields: row.fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { identityName: 'Branch-A', policyType: 'dns' as const, policyName: 'Default DNS Policy' }

test('validate accepts a valid assignment', () => {
  const res = validate(ctxWith([{ fields: good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', () => {
  const res = validate(ctxWith([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires an identity name', () => {
  const res = validate(ctxWith([{ name: '', fields: { ...good, identityName: '' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field.endsWith('.identityName')))
})

test('validate rejects an unknown policy type', () => {
  const res = validate(ctxWith([{ fields: { ...good, policyType: 'proxy' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'invalid_policy_type'))
})

test('validate requires a policy name', () => {
  const res = validate(ctxWith([{ fields: { ...good, policyName: '' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field.endsWith('.policyName')))
})

test('validate rejects an exact duplicate assignment', () => {
  const res = validate(ctxWith([{ fields: good }, { fields: { ...good } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'duplicate_assignment'))
})

test('validate allows the same identity assigned to a different policy type', () => {
  const res = validate(ctxWith([{ fields: good }, { fields: { ...good, policyType: 'web' } }]))
  assert.equal(res.valid, true)
})

test('assignmentKey is case-insensitive and composite', () => {
  assert.equal(assignmentKey(good), assignmentKey({ ...good, identityName: 'BRANCH-A', policyName: 'default dns policy' }))
  assert.notEqual(assignmentKey(good), assignmentKey({ ...good, policyType: 'web' as const }))
})

test('extractPolicyAssignmentSpecs reads fields with defaults', () => {
  const specs = extractPolicyAssignmentSpecs({
    items: [{ id: 'i1', name: 'Fallback', fields: { identityName: '  Branch-B  ', policyName: 'Web Policy' } }],
  } as unknown as PipelineContext['canvas'])
  assert.equal(specs[0].identityName, 'Branch-B')
  assert.equal(specs[0].policyType, 'dns')
  assert.equal(specs[0].policyName, 'Web Policy')
})

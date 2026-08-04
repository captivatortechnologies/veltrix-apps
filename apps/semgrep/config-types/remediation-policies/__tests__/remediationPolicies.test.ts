import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  bundleFromSpecs,
  extractRemediationPolicySpecs,
  isCompleteSpec,
  policiesEqual,
  policyFromSpec,
  remediationPolicySpecFromFields,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Semgrep REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers — all network-free (validate's live dry-run pre-flight is
 * itself skipped whenever ctx.credential / ctx.component are absent, which is
 * the case for every fixture below).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.slug ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  slug: 'block-high-confidence-criticals',
  name: 'Block high-confidence criticals',
  description: '',
  active: true,
  filterMode: 'all',
  conditionsJson: JSON.stringify([{ type: 'severity', values: ['critical'] }]),
  actionsJson: JSON.stringify([{ type: 'block' }, { type: 'pr_comment' }]),
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed remediation policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing slug', async () => {
  const res = await validate(ctxOf([{ ...good, slug: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SLUG'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a duplicate slug (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, slug: good.slug.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_SLUG'))
})

test('validate rejects an invalid filter mode', async () => {
  const res = await validate(ctxOf([{ ...good, filterMode: 'xor' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTER_MODE'))
})

test('validate rejects malformed conditions JSON', async () => {
  const res = await validate(ctxOf([{ ...good, conditionsJson: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONDITIONS_JSON'))
})

test('validate rejects an empty conditions array', async () => {
  const res = await validate(ctxOf([{ ...good, conditionsJson: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONDITIONS'))
})

test('validate rejects a condition missing values', async () => {
  const res = await validate(ctxOf([{ ...good, conditionsJson: JSON.stringify([{ type: 'severity', values: [] }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONDITION_VALUES'))
})

test('validate rejects an invalid condition mode', async () => {
  const res = await validate(ctxOf([{ ...good, conditionsJson: JSON.stringify([{ type: 'severity', values: ['high'], mode: 'sometimes' }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONDITION_MODE'))
})

test('validate rejects malformed actions JSON', async () => {
  const res = await validate(ctxOf([{ ...good, actionsJson: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTIONS_JSON'))
})

test('validate rejects an empty actions array', async () => {
  const res = await validate(ctxOf([{ ...good, actionsJson: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACTIONS'))
})

test('validate rejects an action missing a type', async () => {
  const res = await validate(ctxOf([{ ...good, actionsJson: JSON.stringify([{ config: {} }]) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACTION_TYPE'))
})

// --- _shared helpers ------------------------------------------------------------

test('remediationPolicySpecFromFields parses conditions + actions JSON', () => {
  const spec = remediationPolicySpecFromFields(good)
  assert.equal(spec.conditions?.length, 1)
  assert.equal(spec.actions?.length, 2)
})

test('remediationPolicySpecFromFields reports null on invalid JSON', () => {
  const spec = remediationPolicySpecFromFields({ ...good, conditionsJson: '{bad' })
  assert.equal(spec.conditions, null)
})

test('isCompleteSpec requires slug, name, and parsed conditions/actions', () => {
  const spec = remediationPolicySpecFromFields(good)
  assert.equal(isCompleteSpec(spec), true)
  assert.equal(isCompleteSpec({ ...spec, slug: '' }), false)
  assert.equal(isCompleteSpec({ ...spec, conditions: null }), false)
})

test('policyFromSpec maps the spec onto the API policy shape', () => {
  const spec = remediationPolicySpecFromFields(good)
  const policy = policyFromSpec(spec)
  assert.equal(policy.slug, good.slug)
  assert.equal(policy.filters.mode, 'all')
  assert.equal(policy.actions.length, 2)
})

test('bundleFromSpecs wraps every complete policy and drops incomplete ones', () => {
  const specs = extractRemediationPolicySpecs(ctxOf([good, { ...good, slug: '', name: '' }]).canvas)
  const bundle = bundleFromSpecs(specs)
  assert.equal(bundle.policies.length, 1)
})

test('policiesEqual ignores condition/action ordering', () => {
  const a = policyFromSpec(remediationPolicySpecFromFields(good))
  const reordered = { ...a, actions: [...a.actions].reverse() }
  assert.equal(policiesEqual(a, reordered), true)
})

test('policiesEqual detects a real difference', () => {
  const a = policyFromSpec(remediationPolicySpecFromFields(good))
  const b = { ...a, active: false }
  assert.equal(policiesEqual(a, b), false)
})

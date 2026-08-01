import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseEscalationRules, extractPolicySpecs, parseNumLoops, buildPolicyBody, findPolicy } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure _shared
// helpers (parsing / extraction), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const RULES = '[{"escalation_delay_in_minutes":30,"targets":[{"type":"schedule_reference","id":"PWXYZ12"}]}]'
const good = { name: 'Primary On-Call', description: 'Follows the primary rotation', num_loops: 2, escalation_rules: RULES }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid escalation policy', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects missing escalation rules', async () => {
  const res = await validate(ctxOf([{ ...good, escalation_rules: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULES'))
})

test('validate rejects rules that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, escalation_rules: '[not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULES'))
})

test('validate rejects rules that parse to an empty array', async () => {
  const res = await validate(ctxOf([{ ...good, escalation_rules: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULES'))
})

test('validate rejects a rule whose target type is invalid', async () => {
  const bad = '[{"escalation_delay_in_minutes":30,"targets":[{"type":"team_reference","id":"PT1"}]}]'
  const res = await validate(ctxOf([{ ...good, escalation_rules: bad }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULES'))
})

test('validate rejects a rule with no targets', async () => {
  const bad = '[{"escalation_delay_in_minutes":30,"targets":[]}]'
  const res = await validate(ctxOf([{ ...good, escalation_rules: bad }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULES'))
})

test('validate rejects a negative loop count', async () => {
  const res = await validate(ctxOf([{ ...good, num_loops: -1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NUM_LOOPS'))
})

test('validate accepts a blank (optional) loop count', async () => {
  const res = await validate(ctxOf([{ ...good, num_loops: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('parseEscalationRules returns typed rules for a valid array', () => {
  const parsed = parseEscalationRules(RULES)
  assert.equal(parsed.error, null)
  assert.equal(parsed.rules?.length, 1)
  assert.equal(parsed.rules?.[0].escalation_delay_in_minutes, 30)
  assert.equal(parsed.rules?.[0].targets[0].type, 'schedule_reference')
  assert.equal(parsed.rules?.[0].targets[0].id, 'PWXYZ12')
})

test('parseEscalationRules flags a missing delay', () => {
  const parsed = parseEscalationRules('[{"targets":[{"type":"user_reference","id":"P1"}]}]')
  assert.equal(parsed.rules, null)
  assert.ok(parsed.error)
})

test('parseNumLoops coerces numbers, numeric strings and blanks', () => {
  assert.equal(parseNumLoops(3), 3)
  assert.equal(parseNumLoops('2'), 2)
  assert.equal(parseNumLoops(''), null)
  assert.equal(parseNumLoops(null), null)
})

test('extractPolicySpecs trims the name and carries the raw rules JSON', () => {
  const specs = extractPolicySpecs(ctxOf([{ name: '  Primary  ', escalation_rules: RULES }]).canvas)
  assert.equal(specs[0].name, 'Primary')
  assert.equal(specs[0].rulesJson, RULES)
})

test('buildPolicyBody sets the type and omits blank optional fields', () => {
  const rules = parseEscalationRules(RULES).rules!
  const body = buildPolicyBody({ itemName: 'g', name: 'Primary', description: '', numLoops: null, rulesJson: RULES }, rules)
  assert.equal(body.type, 'escalation_policy')
  assert.equal(body.name, 'Primary')
  assert.equal(body.description, undefined)
  assert.equal(body.num_loops, undefined)
  assert.equal(body.escalation_rules?.length, 1)
})

test('findPolicy matches by name case-insensitively', () => {
  const live = [{ id: 'P1', name: 'Primary On-Call' }, { id: 'P2', name: 'Secondary' }]
  assert.equal(findPolicy(live, 'primary on-call')?.id, 'P1')
  assert.equal(findPolicy(live, 'missing'), null)
})

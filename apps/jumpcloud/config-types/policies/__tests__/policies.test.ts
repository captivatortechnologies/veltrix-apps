import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractPolicySpecs,
  parsePolicyValues,
  buildPolicyBody,
  findPolicyByName,
  templateIdOf,
  normalizeActive,
  priorFieldsOf,
  type JumpCloudPolicy,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/health/drift handlers talk to the JumpCloud API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (network-free).
 */
function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = {
  name: 'Password Complexity',
  templateId: '5f00000000000000000000aa',
  active: true,
  values: '[{"configFieldID":"abc","configFieldName":"minLength","value":12}]',
}

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing template id', async () => {
  const res = await validate(ctxOf([{ ...good, templateId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEMPLATE'))
})

test('validate rejects malformed values JSON', async () => {
  const res = await validate(ctxOf([{ ...good, values: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VALUES'))
})

test('validate rejects values that are not an array', async () => {
  const res = await validate(ctxOf([{ ...good, values: '{"configFieldID":"x"}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_VALUES'))
})

test('validate warns when values are empty (template defaults)', async () => {
  const res = await validate(ctxOf([{ ...good, values: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_VALUES'))
})

test('validate errors on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, values: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ----------------------------------------------------------

test('normalizeActive defaults to true and honours explicit false', () => {
  assert.equal(normalizeActive(undefined), true)
  assert.equal(normalizeActive(true), true)
  assert.equal(normalizeActive(false), false)
  assert.equal(normalizeActive('false'), false)
})

test('parsePolicyValues parses a valid array and rejects a non-object item', () => {
  assert.deepEqual(parsePolicyValues('').values, [])
  const ok = parsePolicyValues('[{"configFieldID":"a","value":1}]')
  assert.equal(ok.error, undefined)
  assert.equal(ok.values[0].configFieldID, 'a')
  assert.ok(parsePolicyValues('[1,2,3]').error)
})

test('extractPolicySpecs trims fields and keeps raw values', () => {
  const [spec] = extractPolicySpecs(canvasOf([{ name: '  P  ', templateId: ' t ', active: false, values: ' [] ' }]))
  assert.equal(spec.name, 'P')
  assert.equal(spec.templateId, 't')
  assert.equal(spec.active, false)
  assert.equal(spec.valuesRaw, '[]')
  assert.equal(spec.itemId, 'i0')
})

test('buildPolicyBody wraps the template id and sends active + values', () => {
  const body = buildPolicyBody(
    { name: 'P', templateId: 't1', active: true, valuesRaw: '' },
    [{ configFieldID: 'a', value: 1 }],
  )
  assert.deepEqual(body.template, { id: 't1' })
  assert.equal(body.active, true)
  assert.deepEqual(body.values, [{ configFieldID: 'a', value: 1 }])
})

test('templateIdOf reads both the object and bare-string template forms', () => {
  assert.equal(templateIdOf({ template: { id: 'x' } }), 'x')
  assert.equal(templateIdOf({ template: 'y' }), 'y')
  assert.equal(templateIdOf({}), '')
})

test('findPolicyByName matches case-insensitively', () => {
  const policies: JumpCloudPolicy[] = [{ id: 'a', name: 'Password Complexity' }, { id: 'b', name: 'Screen Lock' }]
  assert.equal(findPolicyByName(policies, 'password complexity')?.id, 'a')
  assert.equal(findPolicyByName(policies, 'MISSING'), null)
})

test('priorFieldsOf captures name, template, values and active for rollback', () => {
  const prior = priorFieldsOf({
    id: 'a',
    name: 'P',
    template: { id: 't' },
    values: [{ configFieldID: 'a', value: 1 }],
    active: true,
  })
  assert.equal(prior.name, 'P')
  assert.deepEqual(prior.template, { id: 't' })
  assert.deepEqual(prior.values, [{ configFieldID: 'a', value: 1 }])
  assert.equal(prior.active, true)
})

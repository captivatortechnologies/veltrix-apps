import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseConditions,
  dedupeByMetric,
  reconcileConditions,
  gatesFromList,
  findGate,
  defaultGateName,
  normalizeBool,
  formatCondition,
  type SonarCondition,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the SonarQube Web API via node:http(s)
 * inside sonarqubeApi, which is impractical to mock here. Tests focus on validate.ts
 * and _shared, which are pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Veltrix Strict', isDefault: false, conditions: 'new_coverage LT 80\nnew_duplicated_lines_density GT 3' }

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed gate', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a gate with no conditions', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_CONDITIONS'))
})

test('validate rejects a malformed condition line', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: 'new_coverage 80' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONDITION'))
})

test('validate rejects an unknown operator', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: 'new_coverage EQ 80' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_OPERATOR'))
})

test('validate warns on a duplicate gate name', async () => {
  const res = await validate(ctxOf([good, { ...good, conditions: 'bugs GT 0' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate warns when a metric is declared twice in one gate', async () => {
  const res = await validate(ctxOf([{ ...good, conditions: 'new_coverage LT 80\nnew_coverage LT 90' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_METRIC'))
})

test('validate warns when more than one gate is flagged default', async () => {
  const res = await validate(ctxOf([{ ...good, isDefault: true }, { ...good, name: 'Other', isDefault: true }]))
  assert.ok(res.warnings.some((w) => w.code === 'MULTIPLE_DEFAULT'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- parseConditions ---------------------------------------------------------

test('parseConditions parses lines and ignores blanks / comments', () => {
  const { conditions, errors } = parseConditions('new_coverage LT 80\n\n# a comment\nbugs GT 0')
  assert.equal(errors.length, 0)
  assert.deepEqual(conditions, [
    { metric: 'new_coverage', op: 'LT', error: '80' },
    { metric: 'bugs', op: 'GT', error: '0' },
  ])
})

test('parseConditions upper-cases the operator', () => {
  const { conditions } = parseConditions('new_coverage lt 80')
  assert.equal(conditions[0].op, 'LT')
})

test('parseConditions flags a bad token count and a bad operator', () => {
  const bad = parseConditions('metric_only')
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_CONDITION'))
  const badOp = parseConditions('coverage NE 5')
  assert.ok(badOp.errors.some((e) => e.code === 'INVALID_OPERATOR'))
})

// --- dedupeByMetric ----------------------------------------------------------

test('dedupeByMetric keeps the last condition per metric', () => {
  const { conditions, duplicates } = dedupeByMetric([
    { metric: 'new_coverage', op: 'LT', error: '80' },
    { metric: 'new_coverage', op: 'LT', error: '90' },
  ])
  assert.equal(conditions.length, 1)
  assert.equal(conditions[0].error, '90')
  assert.deepEqual(duplicates, ['new_coverage'])
})

// --- reconcileConditions -----------------------------------------------------

test('reconcileConditions creates, updates and deletes by metric', () => {
  const desired = [
    { metric: 'new_coverage', op: 'LT', error: '80' }, // update (threshold changed)
    { metric: 'bugs', op: 'GT', error: '0' }, // create (new)
  ]
  const live: SonarCondition[] = [
    { id: 1, metric: 'new_coverage', op: 'LT', error: '70' },
    { id: 2, metric: 'code_smells', op: 'GT', error: '5' }, // delete (not desired)
  ]
  const { toCreate, toUpdate, toDelete } = reconcileConditions(desired, live)
  assert.deepEqual(toCreate.map((c) => c.metric), ['bugs'])
  assert.deepEqual(toUpdate.map((u) => u.desired.metric), ['new_coverage'])
  assert.deepEqual(toDelete.map((c) => c.metric), ['code_smells'])
})

test('reconcileConditions is a no-op when live matches desired', () => {
  const desired = [{ metric: 'new_coverage', op: 'LT', error: '80' }]
  const live: SonarCondition[] = [{ id: 9, metric: 'new_coverage', op: 'LT', error: '80' }]
  const r = reconcileConditions(desired, live)
  assert.equal(r.toCreate.length, 0)
  assert.equal(r.toUpdate.length, 0)
  assert.equal(r.toDelete.length, 0)
})

// --- list helpers ------------------------------------------------------------

test('gatesFromList unwraps the qualitygates envelope', () => {
  const gates = gatesFromList({ qualitygates: [{ name: 'A' }, { name: 'B' }], default: 1 })
  assert.equal(gates.length, 2)
  assert.equal(gatesFromList({}).length, 0)
})

test('findGate matches by exact name and defaultGateName finds the default', () => {
  const gates = [{ name: 'Strict', isDefault: false }, { name: 'Sonar way', isDefault: true }]
  assert.equal(findGate(gates, 'Strict')?.name, 'Strict')
  assert.equal(findGate(gates, 'missing'), null)
  assert.equal(defaultGateName(gates), 'Sonar way')
})

test('normalizeBool and formatCondition behave', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool(undefined), false)
  assert.equal(formatCondition({ metric: 'new_coverage', op: 'LT', error: '80' }), 'new_coverage LT 80')
})

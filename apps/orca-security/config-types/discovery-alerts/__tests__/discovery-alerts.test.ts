import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildDiscoveryAlertBody,
  fromApiComplianceFrameworks,
  joinComplianceSection,
  normalizeScore,
  splitComplianceSection,
  toApiComplianceFrameworks,
  type ComplianceFrameworkRef,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers apply over the Orca REST API via lib/orcaApi (fetch),
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const ruleJson = { models: ['AzureVNet'], type: 'object_set' }

const good = {
  name: "Azure VNets that aren't in use",
  description: 'Unused VNets',
  category: 'Network misconfigurations',
  orcaScore: 6.2,
  contextScore: false,
  ruleJson: JSON.stringify(ruleJson),
  complianceFrameworks: '',
}

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed discovery alert', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown category', async () => {
  const res = await validate(ctxOf([{ ...good, category: 'Nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CATEGORY'))
})

test('validate accepts a decimal score', async () => {
  const res = await validate(ctxOf([{ ...good, orcaScore: 6.2 }]))
  assert.equal(res.valid, true)
})

test('validate rejects an out-of-range score', async () => {
  const res = await validate(ctxOf([{ ...good, orcaScore: 42 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCORE'))
})

test('validate rejects malformed rule JSON', async () => {
  const res = await validate(ctxOf([{ ...good, ruleJson: '{oops}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RULE_JSON'))
})

test('validate rejects a compliance framework missing a priority', async () => {
  const res = await validate(
    ctxOf([{ ...good, complianceFrameworks: JSON.stringify([{ name: 'F', section: 'A/B' }]) }]),
  )
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_COMPLIANCE_FRAMEWORKS'))
})

test('validate rejects an unknown compliance framework priority', async () => {
  const res = await validate(
    ctxOf([{ ...good, complianceFrameworks: JSON.stringify([{ name: 'F', section: 'A/B', priority: 'urgent' }]) }]),
  )
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PRIORITY'))
})

test('validate accepts a well-formed compliance framework association', async () => {
  const res = await validate(
    ctxOf([{ ...good, complianceFrameworks: JSON.stringify([{ name: 'F', section: 'A/B/C', priority: 'high' }]) }]),
  )
  assert.equal(res.valid, true)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('normalizeScore clamps to the 1..10 range and allows decimals', () => {
  assert.equal(normalizeScore(6.2), 6.2)
  assert.equal(normalizeScore(0), 1)
  assert.equal(normalizeScore(99), 10)
})

test('splitComplianceSection / joinComplianceSection round-trip up to 3 levels', () => {
  assert.deepEqual(splitComplianceSection('A/B/C'), { category: 'A', subCategory: 'B', subSubCategory: 'C' })
  assert.equal(joinComplianceSection('A', 'B', 'C'), 'A/B/C')
  assert.equal(joinComplianceSection('A', '', ''), 'A')
})

test('splitComplianceSection folds a 4th level into sub_sub_category so joining reproduces the input', () => {
  const split = splitComplianceSection('A/B/C/D')
  assert.equal(split.subSubCategory, 'C/D')
  assert.equal(joinComplianceSection(split.category, split.subCategory, split.subSubCategory), 'A/B/C/D')
})

test('toApiComplianceFrameworks / fromApiComplianceFrameworks round-trip', () => {
  const refs: ComplianceFrameworkRef[] = [{ name: 'My Framework', section: 'Identify/Risk Assessment', priority: 'high' }]
  const api = toApiComplianceFrameworks(refs)
  assert.deepEqual(api, [{ compliance_framework: 'My Framework', category: 'Identify', sub_category: 'Risk Assessment', priority: 'high' }])
  assert.deepEqual(fromApiComplianceFrameworks(api), refs)
})

test('buildDiscoveryAlertBody maps canvas fields, always sends negation, omits empty compliance frameworks', () => {
  const body = buildDiscoveryAlertBody(good, ruleJson, [])
  assert.equal(body.name, good.name)
  assert.equal(body.details, good.description)
  assert.equal(body.negation, '')
  assert.equal(body.category, 'Network misconfigurations')
  assert.equal(body.orca_score, 6.2)
  assert.equal(body.context_score, false)
  assert.deepEqual(body.rule_json, ruleJson)
  assert.equal(body.compliance_frameworks, undefined)
})

test('buildDiscoveryAlertBody includes compliance frameworks when given', () => {
  const refs: ComplianceFrameworkRef[] = [{ name: 'F', section: 'A/B', priority: 'low' }]
  const body = buildDiscoveryAlertBody(good, ruleJson, refs)
  assert.deepEqual(body.compliance_frameworks, [{ compliance_framework: 'F', category: 'A', sub_category: 'B', priority: 'low' }])
})

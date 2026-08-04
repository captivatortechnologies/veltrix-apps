import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractTagSpecs, buildTagBody, findTag, parseAssignments, resolveEntityId } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure _shared
// helpers (parsing / extraction / resolution), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.label ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const ASSIGNMENTS = '[{"entity_type":"users","entity_name":"jane@example.com"},{"entity_type":"teams","entity_name":"Platform SRE"}]'
const good = { label: 'Product', assignments: ASSIGNMENTS }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid tag', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a tag with no assignments', async () => {
  const res = await validate(ctxOf([{ label: 'Batman' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing label', async () => {
  const res = await validate(ctxOf([{ ...good, label: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LABEL'))
})

test('validate rejects assignments that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, assignments: '[not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ASSIGNMENTS'))
})

test('validate rejects assignments that are not a JSON array', async () => {
  const res = await validate(ctxOf([{ ...good, assignments: '{"entity_type":"users"}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ASSIGNMENTS'))
})

test('validate rejects an assignment with an invalid entity_type', async () => {
  const bad = '[{"entity_type":"services","entity_name":"Payments"}]'
  const res = await validate(ctxOf([{ ...good, assignments: bad }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ASSIGNMENTS'))
})

test('validate rejects an assignment with a blank entity_name', async () => {
  const bad = '[{"entity_type":"teams","entity_name":""}]'
  const res = await validate(ctxOf([{ ...good, assignments: bad }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ASSIGNMENTS'))
})

test('validate accepts an empty assignments array', async () => {
  const res = await validate(ctxOf([{ ...good, assignments: '[]' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate label', async () => {
  const res = await validate(ctxOf([good, { ...good, assignments: '[]' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_LABEL'))
})

test('parseAssignments treats a blank input as an empty (valid) array', () => {
  const parsed = parseAssignments(undefined)
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.assignments, [])
})

test('parseAssignments returns typed assignments for a valid array', () => {
  const parsed = parseAssignments(ASSIGNMENTS)
  assert.equal(parsed.error, null)
  assert.equal(parsed.assignments?.length, 2)
  assert.equal(parsed.assignments?.[0].entity_type, 'users')
  assert.equal(parsed.assignments?.[0].entity_name, 'jane@example.com')
  assert.equal(parsed.assignments?.[1].entity_type, 'teams')
})

test('parseAssignments flags an invalid entity_type', () => {
  const parsed = parseAssignments('[{"entity_type":"escalation_policy","entity_name":"Primary"}]')
  assert.equal(parsed.assignments, null)
  assert.ok(parsed.error)
})

test('extractTagSpecs trims the label and carries the raw assignments JSON', () => {
  const specs = extractTagSpecs(ctxOf([{ label: '  Product  ', assignments: ASSIGNMENTS }]).canvas)
  assert.equal(specs[0].label, 'Product')
  assert.equal(specs[0].assignmentsJson, ASSIGNMENTS)
})

test('buildTagBody sets the type and the label', () => {
  const body = buildTagBody({ itemName: 'g', label: 'Product', assignmentsJson: '[]' })
  assert.equal(body.type, 'tag')
  assert.equal(body.label, 'Product')
})

test('findTag matches by label case-insensitively', () => {
  const live = [{ id: 'PT1', label: 'Product' }, { id: 'PT2', label: 'Ops' }]
  assert.equal(findTag(live, 'product')?.id, 'PT1')
  assert.equal(findTag(live, 'missing'), null)
})

test('resolveEntityId matches a user by email case-insensitively', () => {
  const lookups = {
    users: [{ id: 'PU1', email: 'Jane@Example.com' }],
    teams: [],
    escalation_policies: [],
  }
  assert.equal(resolveEntityId('users', 'jane@example.com', lookups), 'PU1')
  assert.equal(resolveEntityId('users', 'missing@example.com', lookups), null)
})

test('resolveEntityId matches a team by name case-insensitively', () => {
  const lookups = { users: [], teams: [{ id: 'PT1', name: 'Platform SRE' }], escalation_policies: [] }
  assert.equal(resolveEntityId('teams', 'platform sre', lookups), 'PT1')
  assert.equal(resolveEntityId('teams', 'missing', lookups), null)
})

test('resolveEntityId matches an escalation policy by name case-insensitively', () => {
  const lookups = { users: [], teams: [], escalation_policies: [{ id: 'PEP1', name: 'Primary On-Call' }] }
  assert.equal(resolveEntityId('escalation_policies', 'primary on-call', lookups), 'PEP1')
  assert.equal(resolveEntityId('escalation_policies', 'missing', lookups), null)
})

test('resolveEntityId returns null for an unrecognized entity_type', () => {
  const lookups = { users: [], teams: [], escalation_policies: [] }
  assert.equal(resolveEntityId('services', 'Payments', lookups), null)
})

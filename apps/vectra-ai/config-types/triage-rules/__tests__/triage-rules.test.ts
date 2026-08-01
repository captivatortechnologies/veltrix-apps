import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRuleBody, parseList, parseHostIds, findRule, rulesFromList, normalizeBool } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The mutating handlers apply over the Vectra REST API via node:https inside
 * vectraApi, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers (body building, list parsing, identity matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.description ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  description: 'Whitelist scanner host',
  detection_category: 'LATERAL MOVEMENT',
  detection: 'Automated Replication',
  triage_category: 'Known Scanner',
  is_whitelist: false,
  all_hosts: true,
}

// --- validate ---------------------------------------------------------------

test('validate accepts a good re-classify rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing description', async () => {
  const res = await validate(ctxOf([{ ...good, description: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESCRIPTION'))
})

test('validate rejects an unknown detection category', async () => {
  const res = await validate(ctxOf([{ ...good, detection_category: 'MADE UP' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CATEGORY'))
})

test('validate rejects a missing detection type', async () => {
  const res = await validate(ctxOf([{ ...good, detection: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DETECTION'))
})

test('validate requires a triage category on a non-whitelist rule', async () => {
  const res = await validate(ctxOf([{ ...good, triage_category: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_TRIAGE_CATEGORY'))
})

test('validate allows a whitelist rule with no triage category', async () => {
  const res = await validate(ctxOf([{ ...good, is_whitelist: true, triage_category: '' }]))
  assert.equal(res.valid, true)
})

test('validate warns when a whitelist rule also sets a triage category', async () => {
  const res = await validate(ctxOf([{ ...good, is_whitelist: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'TRIAGE_CATEGORY_IGNORED'))
})

test('validate requires a scope when all_hosts is off', async () => {
  const res = await validate(ctxOf([{ ...good, all_hosts: false }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_SCOPE'))
})

test('validate accepts a host-scoped rule with all_hosts off', async () => {
  const res = await validate(ctxOf([{ ...good, all_hosts: false, host: '3345, 3410' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a malformed IP / CIDR', async () => {
  const res = await validate(ctxOf([{ ...good, ip: '10.1.1.0/24, 999.1.1.1' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_IP'))
})

test('validate warns on a duplicate description', async () => {
  const res = await validate(ctxOf([good, { ...good, detection: 'Other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_DESCRIPTION'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('parseList splits, trims and de-duplicates', () => {
  assert.deepEqual(parseList('ssh, tcp  ssh , udp'), ['ssh', 'tcp', 'udp'])
  assert.deepEqual(parseList(''), [])
})

test('parseHostIds keeps only numeric ids', () => {
  assert.deepEqual(parseHostIds('3345, abc, 3410'), [3345, 3410])
})

test('normalizeBool coerces common truthy strings', () => {
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool(1), true)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool(undefined), false)
})

test('buildRuleBody omits triage_category for a whitelist rule', () => {
  const body = buildRuleBody({ ...good, is_whitelist: true })
  assert.equal(body.is_whitelist, true)
  assert.equal('triage_category' in body, false)
})

test('buildRuleBody includes triage_category + scope arrays for a re-classify rule', () => {
  const body = buildRuleBody({ ...good, all_hosts: false, host: '3345', ip: '10.0.0.1', remote1_proto: 'ssh, tcp' })
  assert.equal(body.triage_category, 'Known Scanner')
  assert.deepEqual(body.host, [3345])
  assert.deepEqual(body.ip, ['10.0.0.1'])
  assert.deepEqual(body.remote1_proto, ['ssh', 'tcp'])
})

test('rulesFromList unwraps the DRF results envelope', () => {
  assert.deepEqual(rulesFromList({ count: 1, results: [{ id: 1 }] }), [{ id: 1 }])
  assert.deepEqual(rulesFromList([{ id: 2 }]), [{ id: 2 }])
  assert.deepEqual(rulesFromList(null), [])
})

test('findRule matches by description', () => {
  const rules = [{ id: 1, description: 'A' }, { id: 2, description: 'B' }]
  assert.equal(findRule(rules, 'B')?.id, 2)
  assert.equal(findRule(rules, 'C'), null)
})

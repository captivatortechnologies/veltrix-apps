import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildPolicyBody,
  parseConfigurationBlob,
  isValidJsonObject,
  checkKnownEnums,
  diffDeclaredKeys,
  policiesFromResponse,
  policyDetailFromResponse,
  findPolicyByName,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Cybereason REST API via
 * node:https, which is impractical to mock here. Tests focus on validate.ts and
 * the pure _shared helpers — network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Standard Workstation', description: 'Default policy', configuration: '{"antiMalware":{"detectMode":2,"enabled":true}}' }

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a blank configuration', async () => {
  const res = await validate(ctxOf([{ name: 'Empty', configuration: '' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects invalid JSON configuration', async () => {
  const res = await validate(ctxOf([{ ...good, configuration: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIGURATION'))
})

test('validate rejects a JSON array configuration (must be an object)', async () => {
  const res = await validate(ctxOf([{ ...good, configuration: '[1,2,3]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIGURATION'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate warns on an unknown enum value', async () => {
  const res = await validate(ctxOf([{ ...good, configuration: '{"antiMalware":{"detectMode":99}}' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNKNOWN_ENUM_VALUE'))
})

test('validate always flags the unverified policy-update endpoint', async () => {
  const res = await validate(ctxOf([good]))
  assert.ok(res.warnings.some((w) => w.code === 'POLICY_UPDATE_UNVERIFIED'))
})

// --- _shared helpers --------------------------------------------------------

test('isValidJsonObject accepts blank + a JSON object, rejects arrays/broken JSON', () => {
  assert.equal(isValidJsonObject(''), true)
  assert.equal(isValidJsonObject('{"a":1}'), true)
  assert.equal(isValidJsonObject('[1,2]'), false)
  assert.equal(isValidJsonObject('{a:1'), false)
})

test('parseConfigurationBlob parses an object and defaults blank to {}', () => {
  assert.deepEqual(parseConfigurationBlob(''), {})
  assert.deepEqual(parseConfigurationBlob('{"antiMalware":{"enabled":true}}'), { antiMalware: { enabled: true } })
})

test('checkKnownEnums flags an out-of-range known enum and ignores unknown fields', () => {
  const problems = checkKnownEnums({ antiMalware: { detectMode: 99 }, someUnknownSection: { x: 1 } })
  assert.equal(problems.length, 1)
  assert.equal(problems[0].path, 'antiMalware.detectMode')
})

test('checkKnownEnums passes a valid known enum', () => {
  assert.deepEqual(checkKnownEnums({ antiMalware: { detectMode: 2 }, arw: { mode: 'PREVENT' } }), [])
})

test('buildPolicyBody merges typed name/description over the configuration blob', () => {
  const body = buildPolicyBody({
    name: 'My Policy',
    description: 'desc',
    configuration: '{"nameDescription":{"name":"stale","groupId":"g1"},"antiMalware":{"enabled":true}}',
  })
  assert.equal((body.nameDescription as Record<string, unknown>).name, 'My Policy')
  assert.equal((body.nameDescription as Record<string, unknown>).description, 'desc')
  // groupId from the authored blob survives since the typed fields don't collide with it
  assert.equal((body.nameDescription as Record<string, unknown>).groupId, 'g1')
  assert.deepEqual(body.antiMalware, { enabled: true })
})

test('buildPolicyBody omits blank description/notes', () => {
  const body = buildPolicyBody({ name: 'P', configuration: '' })
  assert.equal('description' in (body.nameDescription as Record<string, unknown>), false)
  assert.equal('notes' in (body.nameDescription as Record<string, unknown>), false)
})

test('diffDeclaredKeys only compares declared keys, at any nesting depth', () => {
  const declared = { antiMalware: { enabled: true, detectMode: 2 } }
  const live = { antiMalware: { enabled: false, detectMode: 2, extraLiveOnlyField: 'x' } }
  const diffs = diffDeclaredKeys(declared, live)
  assert.equal(diffs.length, 1)
  assert.equal(diffs[0].path, 'antiMalware.enabled')
  assert.equal(diffs[0].expected, true)
  assert.equal(diffs[0].actual, false)
})

test('diffDeclaredKeys reports no drift when declared matches live', () => {
  const declared = { antiMalware: { enabled: true } }
  assert.deepEqual(diffDeclaredKeys(declared, { antiMalware: { enabled: true } }), [])
})

test('policiesFromResponse unwraps a bare array and a { policies } envelope', () => {
  assert.equal(policiesFromResponse(JSON.stringify([{ id: '1', name: 'a' }])).length, 1)
  assert.equal(policiesFromResponse(JSON.stringify({ policies: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] })).length, 2)
  assert.equal(policiesFromResponse('not json').length, 0)
})

test('policyDetailFromResponse parses { metadata, configuration }', () => {
  const detail = policyDetailFromResponse(JSON.stringify({ metadata: { id: '1', isDefault: true }, configuration: { antiMalware: {} } }))
  assert.equal(detail?.metadata?.isDefault, true)
  assert.deepEqual(detail?.configuration, { antiMalware: {} })
  assert.equal(policyDetailFromResponse('not json'), null)
})

test('findPolicyByName matches case-insensitively', () => {
  const rows = [{ id: 'p1', name: 'Standard Workstation' }]
  const match = findPolicyByName(rows, 'standard workstation')
  assert.ok(match)
  assert.equal(match?.id, 'p1')
})

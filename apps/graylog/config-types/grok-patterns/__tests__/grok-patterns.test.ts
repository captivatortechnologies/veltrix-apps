import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildGrokPatternBody, bodyFromLiveGrokPattern, grokPatternsFromList, findGrokPattern } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Graylog REST API via
 * node:https inside graylogApi, which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers (body building, identity
 * matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'CLIENT_ADDR', pattern: '%{IPV4:client_ip}:%{POSINT:client_port}' }

test('validate accepts a well-formed pattern', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name with invalid characters', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'client-addr' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a missing pattern', async () => {
  const res = await validate(ctxOf([{ ...good, pattern: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PATTERN'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, pattern: '%{GREEDYDATA}' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildGrokPatternBody trims and carries name + pattern', () => {
  const body = buildGrokPatternBody({ ...good, pattern: `  ${good.pattern}  ` })
  assert.equal(body.name, 'CLIENT_ADDR')
  assert.equal(body.pattern, good.pattern)
})

test('bodyFromLiveGrokPattern maps a live pattern back to a request body', () => {
  const body = bodyFromLiveGrokPattern({ id: '1', name: 'X', pattern: 'Y' })
  assert.equal(body.name, 'X')
  assert.equal(body.pattern, 'Y')
})

test('grokPatternsFromList + findGrokPattern match by name from the API envelope', () => {
  const live = grokPatternsFromList({ patterns: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] })
  assert.equal(live.length, 2)
  assert.equal(findGrokPattern(live, 'B')?.id, '2')
  assert.equal(findGrokPattern(live, 'nope'), null)
})

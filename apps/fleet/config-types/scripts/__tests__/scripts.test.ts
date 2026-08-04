import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { toFilename, toTeamId } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Fleet REST API (multipart/form-data uploads)
 * via node:https inside fleetApi, which is impractical to mock here. Tests
 * focus on validate.ts and the pure _shared.ts helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'rotate_bitlocker_key',
  scriptType: 'sh',
  scriptContent: 'echo "hello"',
  teamId: '',
}

test('validate rejects a name containing an extension/dot', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'script.sh' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unknown script type', async () => {
  const res = await validate(ctxOf([{ ...good, scriptType: 'py' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCRIPT_TYPE'))
})

test('validate rejects empty content', async () => {
  const res = await validate(ctxOf([{ ...good, scriptContent: '   ' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONTENT'))
})

test('validate rejects content over the 10,000-character run-script limit', async () => {
  const res = await validate(ctxOf([{ ...good, scriptContent: 'x'.repeat(9600) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'CONTENT_TOO_LARGE'))
})

test('validate rejects a non-numeric team id', async () => {
  const res = await validate(ctxOf([{ ...good, teamId: 'prod' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TEAM_ID'))
})

test('validate accepts a good script', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name+type but stays valid', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared.ts -------------------------------------------------------------

test('toFilename appends .sh or .ps1 based on scriptType', () => {
  assert.equal(toFilename('check', 'sh'), 'check.sh')
  assert.equal(toFilename('check', 'ps1'), 'check.ps1')
  assert.equal(toFilename('check', 'unknown'), 'check.sh')
})

test('toTeamId maps blank to undefined ("Unassigned") and parses numbers', () => {
  assert.equal(toTeamId(''), undefined)
  assert.equal(toTeamId('12'), 12)
})

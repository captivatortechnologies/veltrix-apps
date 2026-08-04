import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractCommandSpecs,
  toIdList,
  normalizeSudo,
  buildCommandBody,
  findCommandByName,
  priorFieldsOf,
  type JumpCloudCommand,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = { name: 'Patch Check', command: 'apt list --upgradable', commandType: 'linux', user: 'u1', launchType: 'repeated', schedule: '0 0 * * * *' }

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing command body', async () => {
  const res = await validate(ctxOf([{ ...good, command: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_COMMAND'))
})

test('validate rejects an unrecognized OS', async () => {
  const res = await validate(ctxOf([{ ...good, commandType: 'solaris' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_OS'))
})

test('validate rejects an out-of-range timeout', async () => {
  const res = await validate(ctxOf([{ ...good, timeout: '999999' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIMEOUT'))
})

test('validate warns when no run-as user and not trigger-launched', async () => {
  const res = await validate(ctxOf([{ ...good, user: '', launchType: 'manual' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_USER'))
})

test('validate does not warn about a missing user for a trigger-launched command', async () => {
  const res = await validate(ctxOf([{ ...good, user: '', launchType: 'trigger', trigger: 'deploy-hook' }]))
  assert.equal(res.warnings.some((w) => w.code === 'NO_USER'), false)
})

test('validate errors on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ----------------------------------------------------------

test('toIdList splits, trims and de-dupes case-insensitively', () => {
  assert.deepEqual(toIdList('a, B\nA'), ['a', 'B'])
})

test('normalizeSudo defaults false and honours truthy strings', () => {
  assert.equal(normalizeSudo(undefined), false)
  assert.equal(normalizeSudo('true'), true)
})

test('extractCommandSpecs trims fields and defaults commandType to linux', () => {
  const [spec] = extractCommandSpecs(canvasOf([{ name: ' C ', command: ' echo hi ' }]))
  assert.equal(spec.name, 'C')
  assert.equal(spec.command, 'echo hi')
  assert.equal(spec.commandType, 'linux')
  assert.equal(spec.itemId, 'i0')
})

test('buildCommandBody sends every managed field', () => {
  const body = buildCommandBody({
    name: 'C', description: '', command: 'echo hi', commandType: 'linux', shell: '', user: 'u1', sudo: true,
    launchType: 'manual', schedule: '', scheduleRepeatType: '', trigger: '', timeout: '60', commandRunners: ['r1'],
  })
  assert.equal(body.name, 'C')
  assert.equal(body.sudo, true)
  assert.deepEqual(body.commandRunners, ['r1'])
})

test('findCommandByName matches case-insensitively', () => {
  const commands: JumpCloudCommand[] = [{ _id: 'a', name: 'Patch Check' }]
  assert.equal(findCommandByName(commands, 'patch check')?._id, 'a')
  assert.equal(findCommandByName(commands, 'MISSING'), null)
})

test('priorFieldsOf captures every managed field for rollback', () => {
  const prior = priorFieldsOf({ _id: 'a', name: 'C', command: 'echo hi', sudo: true, commandRunners: ['r1'] })
  assert.equal(prior.name, 'C')
  assert.equal(prior.command, 'echo hi')
  assert.equal(prior.sudo, true)
  assert.deepEqual(prior.commandRunners, ['r1'])
})

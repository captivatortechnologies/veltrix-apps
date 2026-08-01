import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildMacroBody, conditionOf, findMacroByName, normalizeEnabled } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { SysdigMacro } from '../../../lib/sysdigApi'

/**
 * The deploy/rollback/drift handlers call the Sysdig Secure REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * mapping helpers in _shared.ts, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'outbound_connection',
  condition: 'evt.type in (connect, sendto, sendmsg)',
  enabled: true,
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing condition', async () => {
  const res = await validate(ctxOf([{ ...good, condition: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONDITION'))
})

test('validate accepts a good macro', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate macro name', async () => {
  const res = await validate(ctxOf([good, { ...good, condition: 'evt.type=execve' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeEnabled defaults to enabled and reads disabled/false/0', () => {
  assert.equal(normalizeEnabled(undefined), true)
  assert.equal(normalizeEnabled('disabled'), false)
  assert.equal(normalizeEnabled('0'), false)
})

test('buildMacroBody maps canvas fields to the Sysdig macro shape', () => {
  const macro = buildMacroBody(good)
  assert.equal(macro.name, good.name)
  assert.deepEqual(macro.condition, { condition: good.condition })
  assert.equal(macro.append, false)
})

test('findMacroByName matches by exact name', () => {
  const macros: SysdigMacro[] = [
    { name: 'A', condition: { condition: 'x' } },
    { name: 'outbound_connection', id: 9, condition: { condition: 'evt.type=connect' } },
  ]
  assert.equal(findMacroByName(macros, 'outbound_connection')?.id, 9)
  assert.equal(findMacroByName(macros, 'missing'), null)
  assert.equal(findMacroByName(macros, ''), null)
})

test('conditionOf unwraps a live macro condition', () => {
  const macro: SysdigMacro = { name: 'm', condition: { condition: '  evt.type=open  ' } }
  assert.equal(conditionOf(macro), 'evt.type=open')
  assert.equal(conditionOf(null), '')
})

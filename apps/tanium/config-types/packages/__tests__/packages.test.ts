import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildPackageBody, restorePackageBody, packageTimeout, parseNonNegativeInt } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Tanium REST v2 API via
 * node:https, which is impractical to mock here. Tests focus on validate.ts and
 * the pure, network-free helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'List Dir', command: 'cmd /c dir', comment: 'quick check' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a package with no command', async () => {
  const res = await validate(ctxOf([{ name: 'NoCmd', command: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_COMMAND'))
})

test('validate rejects a non-numeric command timeout', async () => {
  const res = await validate(ctxOf([{ ...good, commandTimeout: 'soon' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIMEOUT'))
})

test('validate accepts numeric timeout and expiry', async () => {
  const res = await validate(ctxOf([{ ...good, commandTimeout: '180', expireSeconds: '600' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good package', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared body builders --------------------------------------------------

test('buildPackageBody maps name + command and omits blank optionals', () => {
  const body = buildPackageBody(good)
  assert.equal(body.name, 'List Dir')
  assert.equal(body.command, 'cmd /c dir')
  assert.equal(body.display_name, undefined)
  assert.equal(body.command_timeout_seconds, undefined)
  assert.equal(body.expire_seconds, undefined)
})

test('buildPackageBody attaches optional fields when present', () => {
  const body = buildPackageBody({ ...good, displayName: 'Dir', commandTimeout: '180', expireSeconds: '600' })
  assert.equal(body.display_name, 'Dir')
  assert.equal(body.command_timeout_seconds, 180)
  assert.equal(body.expire_seconds, 600)
})

test('restorePackageBody rebuilds from a prior package, tolerating either timeout field', () => {
  const body = restorePackageBody({ name: 'P', command: 'echo hi', display_name: 'P', command_timeout: 90, expire_seconds: 300 })
  assert.equal(body.command, 'echo hi')
  assert.equal(body.command_timeout_seconds, 90)
  assert.equal(body.expire_seconds, 300)
})

test('packageTimeout prefers command_timeout_seconds then command_timeout', () => {
  assert.equal(packageTimeout({ command_timeout_seconds: 10, command_timeout: 20 }), 10)
  assert.equal(packageTimeout({ command_timeout: 20 }), 20)
  assert.equal(packageTimeout({}), undefined)
})

test('parseNonNegativeInt validates seconds', () => {
  assert.equal(parseNonNegativeInt('0').value, 0)
  assert.equal(parseNonNegativeInt('').value, undefined)
  assert.ok(parseNonNegativeInt('-5').error)
  assert.ok(parseNonNegativeInt('1.5').error)
})

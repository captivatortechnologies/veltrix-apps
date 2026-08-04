import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCustomIntegrationBody, buildCustomIntegrationBodyFromPrior, findCustomIntegration, type RunzeroCustomIntegration } from '../_shared'
import { coerceList } from '../../../lib/runzeroApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift/health hit the runZero console API via fetch, which is impractical to
 * mock here. Tests focus on validate.ts and the network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'my-custom-integration', description: 'Imports assets from Acme CMDB' }

// --- validate -------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name with spaces', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'my custom integration' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_HAS_SPACES'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid custom integration', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate warns on a suspect base64 icon', async () => {
  const res = await validate(ctxOf([{ ...good, iconBase64: 'not base64!!' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SUSPECT_ICON_BASE64'))
})

test('validate accepts a plausible base64 icon without warning', async () => {
  const res = await validate(ctxOf([{ ...good, iconBase64: 'iVBORw0KGgoAAAANSUhEUg==' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'SUSPECT_ICON_BASE64'))
})

// --- _shared helpers ------------------------------------------------------

test('buildCustomIntegrationBody omits icon when blank', () => {
  const body = buildCustomIntegrationBody({ name: ' my-integration ', description: 'd' })
  assert.deepEqual(body, { name: 'my-integration', description: 'd' })
})

test('buildCustomIntegrationBody includes icon when set', () => {
  const body = buildCustomIntegrationBody({ name: 'my-integration', iconBase64: 'aGVsbG8=' })
  assert.equal(body.icon, 'aGVsbG8=')
})

test('buildCustomIntegrationBodyFromPrior restores a recorded integration', () => {
  const prior: RunzeroCustomIntegration = { id: 'ci-1', name: 'my-integration', description: 'd', icon: 'aGVsbG8=' }
  const body = buildCustomIntegrationBodyFromPrior(prior)
  assert.deepEqual(body, { name: 'my-integration', description: 'd', icon: 'aGVsbG8=' })
})

test('findCustomIntegration matches by name case-insensitively', () => {
  const integrations = [{ id: '1', name: 'my-integration' }, { id: '2', name: 'other-integration' }]
  assert.equal(findCustomIntegration(integrations, 'MY-INTEGRATION')?.id, '1')
  assert.equal(findCustomIntegration(integrations, 'nope'), null)
})

test('coerceList accepts a bare array and a { data } envelope', () => {
  assert.equal(coerceList([{ id: '1' }]).length, 1)
  assert.equal(coerceList({ data: [{ id: '1' }, { id: '2' }] }).length, 2)
  assert.equal(coerceList(null).length, 0)
})

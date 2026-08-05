import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return {
    canvas: { items: list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields })) },
  } as unknown as PipelineContext
}

const good = {
  name: 'prod-images-critical',
  applicationScopes: ['Global'],
  cvssSeverityEnabled: true,
  cvssSeverity: 'critical',
  maximumScoreEnabled: true,
  maximumScore: 9,
  enforceAfterDays: 0,
}

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a policy with no application scopes', async () => {
  const res = await validate(ctxOf([{ ...good, applicationScopes: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPES'))
})

test('validate rejects an invalid severity', async () => {
  const res = await validate(ctxOf([{ ...good, cvssSeverity: 'ultra' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate rejects an out-of-range CVSS score', async () => {
  const res = await validate(ctxOf([{ ...good, maximumScore: 11 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCORE'))
})

test('validate rejects a negative enforce-after-days', async () => {
  const res = await validate(ctxOf([{ ...good, enforceAfterDays: -1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DAYS'))
})

test('validate warns on a duplicate policy name', async () => {
  const res = await validate(ctxOf([good, { ...good, cvssSeverity: 'low' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed policy', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

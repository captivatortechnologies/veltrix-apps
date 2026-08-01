import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { spec } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * Network handlers run through the shared table-config engine; tests focus on
 * validate.ts and the pure spec.buildBody mapping.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Nightly SOC digest',
  active: true,
  runType: 'daily',
  runTime: '02:00:00',
  runStart: '',
  runDayofweek: '',
  runPeriod: '',
  runAs: '',
  conditional: false,
  condition: '',
  script: "(function() { gs.info('digest'); })();",
}

test('validate accepts a well-formed scheduled job', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid run type', async () => {
  const res = await validate(ctxOf([{ ...good, runType: 'hourly' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RUN_TYPE'))
})

test('validate accepts each valid run type', async () => {
  for (const runType of ['daily', 'weekly', 'monthly', 'periodically', 'once', 'on_demand']) {
    const extra = runType === 'weekly' ? { runDayofweek: '1' } : runType === 'periodically' ? { runPeriod: '1970-01-01 00:30:00' } : {}
    const res = await validate(ctxOf([{ ...good, runType, ...extra }]))
    assert.equal(res.valid, true, `expected run type ${runType} to be valid`)
  }
})

test('validate rejects a missing script', async () => {
  const res = await validate(ctxOf([{ ...good, script: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCRIPT'))
})

test('validate warns when a weekly job has no day of week', async () => {
  const res = await validate(ctxOf([{ ...good, runType: 'weekly', runDayofweek: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_DAYOFWEEK'))
})

test('validate warns when a periodic job has no interval', async () => {
  const res = await validate(ctxOf([{ ...good, runType: 'periodically', runPeriod: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_PERIOD'))
})

test('validate warns when a conditional job has no condition', async () => {
  const res = await validate(ctxOf([{ ...good, conditional: true, condition: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_CONDITION'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, script: 'other();' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_IDENTITY'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('spec.buildBody maps canvas fields to sysauto_script columns with coerced types', () => {
  const body = spec.buildBody(good)
  assert.equal(body.name, 'Nightly SOC digest')
  assert.equal(body.active, true)
  assert.equal(body.run_type, 'daily')
  assert.equal(body.run_time, '02:00:00')
  assert.equal(body.conditional, false)
  assert.ok(String(body.script).includes('gs.info'))
})

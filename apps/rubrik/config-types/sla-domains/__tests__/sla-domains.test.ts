import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildFrequencies,
  buildSlaBody,
  findSlaByName,
  hasAnyTier,
  slaDomainsFromList,
  summarizeFrequencies,
  toInt,
  type RubrikSlaDomain,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Rubrik CDM REST API via
 * node:https inside rubrikApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared.ts builders, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Gold', dailyFrequency: 1, dailyRetention: 30 }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an SLA with no configured tier', async () => {
  const res = await validate(ctxOf([{ name: 'Empty', dailyFrequency: 0, dailyRetention: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_TIER'))
})

test('validate rejects duplicate names', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate warns on a half-configured tier', async () => {
  const res = await validate(ctxOf([{ name: 'Half', dailyFrequency: 1, dailyRetention: 30, weeklyFrequency: 2, weeklyRetention: 0 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'PARTIAL_TIER'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed multi-tier SLA', async () => {
  const res = await validate(
    ctxOf([
      {
        name: 'Platinum',
        hourlyFrequency: 4,
        hourlyRetention: 3,
        dailyFrequency: 1,
        dailyRetention: 30,
        weeklyFrequency: 1,
        weeklyRetention: 12,
        weeklyDayOfWeek: 'Sunday',
        monthlyFrequency: 1,
        monthlyRetention: 12,
        monthlyDayOfMonth: 'LastDay',
      },
    ]),
  )
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- toInt ------------------------------------------------------------------

test('toInt coerces strings and floors, clamping invalid/negative to 0', () => {
  assert.equal(toInt('7'), 7)
  assert.equal(toInt(3.9), 3)
  assert.equal(toInt('-2'), 0)
  assert.equal(toInt(''), 0)
  assert.equal(toInt(undefined), 0)
})

// --- buildFrequencies -------------------------------------------------------

test('buildFrequencies includes only tiers with positive frequency AND retention', () => {
  const f = buildFrequencies({ dailyFrequency: 1, dailyRetention: 30, weeklyFrequency: 1, weeklyRetention: 0 })
  assert.deepEqual(f.daily, { frequency: 1, retention: 30 })
  assert.equal(f.weekly, undefined)
  assert.equal(hasAnyTier(f), true)
})

test('buildFrequencies attaches dayOfWeek/dayOfMonth anchors and defaults them', () => {
  const f = buildFrequencies({
    weeklyFrequency: 1,
    weeklyRetention: 4,
    weeklyDayOfWeek: 'Monday',
    monthlyFrequency: 1,
    monthlyRetention: 6,
    monthlyDayOfMonth: 'bogus',
  })
  assert.equal(f.weekly?.dayOfWeek, 'Monday')
  assert.equal(f.monthly?.dayOfMonth, 'LastDay') // invalid falls back
})

// --- buildSlaBody -----------------------------------------------------------

test('buildSlaBody emits name, frequencies and required empty window arrays', () => {
  const body = buildSlaBody({ name: '  Gold  ', dailyFrequency: 1, dailyRetention: 30, description: 'tier-1' }) as {
    name: string
    description?: string
    frequencies: Record<string, unknown>
    allowedBackupWindows: unknown[]
    firstFullAllowedBackupWindows: unknown[]
  }
  assert.equal(body.name, 'Gold')
  assert.equal(body.description, 'tier-1')
  assert.deepEqual(body.frequencies.daily, { frequency: 1, retention: 30 })
  assert.deepEqual(body.allowedBackupWindows, [])
  assert.deepEqual(body.firstFullAllowedBackupWindows, [])
})

test('buildSlaBody omits an empty description', () => {
  const body = buildSlaBody({ name: 'Gold', dailyFrequency: 1, dailyRetention: 30 }) as { description?: string }
  assert.equal('description' in body, false)
})

// --- list parsing + identity match ------------------------------------------

test('slaDomainsFromList unwraps the v2 { data } envelope and bare arrays', () => {
  assert.equal(slaDomainsFromList({ data: [{ name: 'A' }], total: 1 }).length, 1)
  assert.equal(slaDomainsFromList([{ name: 'B' }]).length, 1)
  assert.equal(slaDomainsFromList(null).length, 0)
})

test('findSlaByName matches on the exact trimmed name', () => {
  const list: RubrikSlaDomain[] = [{ id: '1', name: 'Gold' }, { id: '2', name: 'Silver' }]
  assert.equal(findSlaByName(list, ' Gold ')?.id, '1')
  assert.equal(findSlaByName(list, 'Bronze'), null)
})

// --- drift summary ----------------------------------------------------------

test('summarizeFrequencies flattens tiers for comparison and omits off tiers', () => {
  const summary = summarizeFrequencies({ daily: { frequency: 1, retention: 30 }, weekly: { frequency: 1, retention: 4, dayOfWeek: 'Sunday' } })
  assert.equal(summary.daily, '1/30')
  assert.equal(summary.weekly, '1/4@Sunday')
  assert.equal(summary.monthly, undefined)
})

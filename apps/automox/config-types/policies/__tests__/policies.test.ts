import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractPolicySpecs, buildPatchConfiguration, buildPolicyBody, type PolicySpec } from '../_shared'
import { dayNamesToBitmask, findPolicyByName, policyKey, priorFieldsOf, parseDeviceFilters, type AutomoxPolicy } from '../../lib/automoxPolicies'
import { readBool, strList, intList } from '../../lib/canvasValues'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/health/drift handlers talk to the Automox Console API
 * via fetch, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared / lib helpers (network-free).
 */
function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const goodPatch = {
  name: 'Patch All - Windows',
  schedule_days: ['monday', 'wednesday', 'friday'],
  schedule_time: '02:00',
  server_groups: ['1001', '1002'],
  patch_rule: 'all',
}

function specOf(fields: Record<string, unknown>): PolicySpec {
  return extractPolicySpecs(canvasOf([fields]))[0]
}

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...goodPatch, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a well-formed Patch All policy', async () => {
  const res = await validate(ctxOf([goodPatch]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a malformed schedule time', async () => {
  const res = await validate(ctxOf([{ ...goodPatch, schedule_time: '25:99' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCHEDULE_TIME'))
})

test('validate warns (not errors) when no schedule days are selected', async () => {
  const res = await validate(ctxOf([{ ...goodPatch, schedule_days: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNSCHEDULED'))
})

test('validate rejects non-numeric server group ids', async () => {
  const res = await validate(ctxOf([{ ...goodPatch, server_groups: ['abc'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SERVER_GROUPS'))
})

test('validate rejects Filter Rule with no filters and no severities', async () => {
  const res = await validate(ctxOf([{ ...goodPatch, patch_rule: 'filter', filter_type: 'include', filters: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PATCH_CONFIGURATION'))
})

test('validate accepts Filter Rule with filters supplied', async () => {
  const res = await validate(
    ctxOf([{ ...goodPatch, patch_rule: 'filter', filter_type: 'include', filters: ['*Google Chrome*'] }]),
  )
  assert.equal(res.valid, true)
})

test('validate rejects an invalid severity in severity_filter', async () => {
  const res = await validate(
    ctxOf([{ ...goodPatch, patch_rule: 'filter', filter_type: 'severity', severity_filter: ['important'] }]),
  )
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate rejects malformed device_filters_json', async () => {
  const res = await validate(ctxOf([{ ...goodPatch, device_filters_json: '{ not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEVICE_FILTERS'))
})

test('validate rejects a duplicate name (case-insensitive)', async () => {
  const res = await validate(ctxOf([goodPatch, { ...goodPatch, name: 'patch all - windows' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('validate requires scheduled_timezone when use_scheduled_timezone is set', async () => {
  const res = await validate(ctxOf([{ ...goodPatch, use_scheduled_timezone: true, scheduled_timezone: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field.includes('scheduled_timezone')))
})

// --- lib/automoxPolicies + lib/canvasValues -----------------------------------

test('dayNamesToBitmask matches Automox verified bit values', () => {
  assert.equal(dayNamesToBitmask(['sunday']), 128)
  assert.equal(dayNamesToBitmask(['monday']), 2)
  assert.equal(dayNamesToBitmask(['saturday']), 64)
  assert.equal(dayNamesToBitmask(['monday', 'wednesday', 'friday']), 2 | 8 | 32)
  assert.equal(dayNamesToBitmask([]), 0)
  assert.equal(dayNamesToBitmask(['not-a-day']), 0)
})

test('extractPolicySpecs trims fields, defaults schedule_time and reads lists', () => {
  const spec = specOf({ name: '  Patch  ', schedule_time: '', server_groups: '1,2, 3' })
  assert.equal(spec.name, 'Patch')
  assert.equal(spec.scheduleTime, '00:00')
  assert.deepEqual(spec.serverGroups, [1, 2, 3])
})

test('readBool and strList/intList behave as documented', () => {
  assert.equal(readBool(undefined, true), true)
  assert.equal(readBool('false', true), false)
  assert.equal(readBool(false, true), false)
  assert.deepEqual(strList(['a', ' b ']), ['a', 'b'])
  assert.deepEqual(strList('a,b, '), ['a', 'b'])
  assert.deepEqual(intList(['1', '2.5', 'x', '-1', '3']), [1, 3])
})

test('buildPatchConfiguration forces filter_type="all" for non-filter rules (issue #206)', () => {
  const spec = specOf({ ...goodPatch, patch_rule: 'all' })
  const built = buildPatchConfiguration(spec)
  assert.equal(built.error, undefined)
  assert.equal(built.configuration.filter_type, 'all')
})

test('buildPatchConfiguration sets device_filters_enabled only when filters are present', () => {
  const empty = buildPatchConfiguration(specOf({ ...goodPatch }))
  assert.equal(empty.configuration.device_filters_enabled, false)

  const withFilters = buildPatchConfiguration(
    specOf({ ...goodPatch, device_filters_json: JSON.stringify([{ field: 'tag', op: 'in', value: ['Windows'] }]) }),
  )
  assert.equal(withFilters.configuration.device_filters_enabled, true)
  assert.deepEqual(withFilters.configuration.device_filters, [{ field: 'tag', op: 'in', value: ['Windows'] }])
})

test('buildPatchConfiguration requires filters for a Filter/Include rule', () => {
  const built = buildPatchConfiguration(specOf({ ...goodPatch, patch_rule: 'filter', filter_type: 'include' }))
  assert.ok(built.error)
})

test('buildPolicyBody auto-fills weeks/months to "all" when scheduled and left blank', () => {
  const built = buildPolicyBody(specOf(goodPatch), 9999)
  assert.equal(built.error, undefined)
  assert.equal(built.body.schedule_weeks_of_month, 62)
  assert.equal(built.body.schedule_months, 8190)
  assert.equal(built.body.organization_id, 9999)
  assert.equal(built.body.policy_type_name, 'patch')
})

test('buildPolicyBody leaves weeks/months at 0 when unscheduled', () => {
  const built = buildPolicyBody(specOf({ ...goodPatch, schedule_days: [] }), 9999)
  assert.equal(built.body.schedule_days, 0)
  assert.equal(built.body.schedule_weeks_of_month, 0)
  assert.equal(built.body.schedule_months, 0)
})

test('buildPolicyBody honors an explicit schedule_weeks_of_month/months override', () => {
  const built = buildPolicyBody(specOf({ ...goodPatch, schedule_weeks_of_month: 2, schedule_months: 1 }), 9999)
  assert.equal(built.body.schedule_weeks_of_month, 2)
  assert.equal(built.body.schedule_months, 1)
})

test('parseDeviceFilters validates field/op/value shape', () => {
  assert.deepEqual(parseDeviceFilters('').filters, [])
  assert.ok(parseDeviceFilters('{ not json').error)
  assert.ok(parseDeviceFilters('{"field":"tag"}').error)
  assert.ok(parseDeviceFilters('[{"field":"bogus","op":"in","value":["x"]}]').error)
  assert.ok(parseDeviceFilters('[{"field":"tag","op":"bogus","value":["x"]}]').error)
  assert.ok(parseDeviceFilters('[{"field":"tag","op":"in","value":[]}]').error)
  const ok = parseDeviceFilters('[{"field":"tag","op":"in","value":["Windows"]}]')
  assert.equal(ok.error, undefined)
  assert.equal(ok.filters[0].field, 'tag')
})

test('findPolicyByName matches case-insensitively and honors expectedType', () => {
  const policies: AutomoxPolicy[] = [
    { id: 1, name: 'Patch All - Windows', policy_type_name: 'patch' },
    { id: 2, name: 'Install Chrome', policy_type_name: 'required_software' },
  ]
  assert.equal(findPolicyByName(policies, 'patch all - windows')?.id, 1)
  assert.equal(findPolicyByName(policies, 'missing'), null)
  // A same-named policy of a DIFFERENT type must not match when expectedType is given —
  // this is what keeps `policies` (patch) and `worklets` from colliding.
  assert.equal(findPolicyByName(policies, 'Install Chrome', 'patch'), null)
  assert.equal(findPolicyByName(policies, 'Install Chrome', 'required_software')?.id, 2)
})

test('policyKey trims and lowercases', () => {
  assert.equal(policyKey('  Patch All  '), 'patch all')
})

test('priorFieldsOf captures the managed fields for rollback', () => {
  const prior = priorFieldsOf({
    id: 1,
    name: 'P',
    policy_type_name: 'patch',
    organization_id: 9999,
    configuration: { auto_patch: true },
    schedule_days: 2,
    schedule_time: '02:00',
    schedule_weeks_of_month: 62,
    schedule_months: 8190,
    server_groups: [1, 2],
    notes: 'n',
  })
  assert.equal(prior.name, 'P')
  assert.equal(prior.policy_type_name, 'patch')
  assert.deepEqual(prior.server_groups, [1, 2])
  assert.equal(prior.schedule_days, 2)
})

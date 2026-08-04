import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildSensorBody,
  restoreSensorBody,
  parseAdditionalQueries,
  parseNonNegativeInt,
  parametersOf,
  queriesOf,
  primaryQueryOf,
} from '../_shared'
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

const good = {
  name: 'Installed Applications',
  platform: 'Windows',
  scriptType: 'PowerShell',
  script: 'Get-CimInstance Win32_Product | Select-Object Name',
  comment: 'inventory sensor',
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a sensor missing platform, script type or script', async () => {
  const res = await validate(ctxOf([{ name: 'Bare' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PLATFORM'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCRIPT_TYPE'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCRIPT'))
})

test('validate rejects invalid additional-queries JSON', async () => {
  const res = await validate(ctxOf([{ ...good, additionalQueriesJson: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ADDITIONAL_QUERIES'))
})

test('validate rejects an additional query missing a required key', async () => {
  const res = await validate(ctxOf([{ ...good, additionalQueriesJson: '[{"platform":"Linux","script":"echo hi"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ADDITIONAL_QUERIES'))
})

test('validate accepts a well-formed additional-queries array', async () => {
  const res = await validate(
    ctxOf([{ ...good, additionalQueriesJson: '[{"platform":"Linux","script":"echo hi","script_type":"Bash"}]' }]),
  )
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a non-numeric max age', async () => {
  const res = await validate(ctxOf([{ ...good, maxAgeSeconds: 'soon' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MAX_AGE'))
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

test('validate accepts a good sensor', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared body builders --------------------------------------------------

test('queriesOf builds the primary query from platform/scriptType/script', () => {
  const queries = queriesOf(good)
  assert.deepEqual(queries, [{ platform: 'Windows', script: good.script, script_type: 'PowerShell' }])
})

test('queriesOf appends parsed additional queries after the primary one', () => {
  const queries = queriesOf({ ...good, additionalQueriesJson: '[{"platform":"Linux","script":"echo hi","script_type":"Bash"}]' })
  assert.equal(queries.length, 2)
  assert.equal(queries[1].platform, 'Linux')
})

test('buildSensorBody maps name + primary query and omits blank optionals', () => {
  const body = buildSensorBody(good)
  assert.equal(body.name, 'Installed Applications')
  assert.equal(body.queries.length, 1)
  assert.equal(body.description, undefined)
  assert.equal(body.category, undefined)
  assert.equal(body.max_age_seconds, undefined)
  assert.equal(body.parameters, undefined)
})

test('buildSensorBody attaches optional fields when present', () => {
  const body = buildSensorBody({
    ...good,
    description: 'Lists installed apps',
    category: 'Software',
    maxAgeSeconds: '3600',
    parameters: { flavor: 'x64' },
  })
  assert.equal(body.description, 'Lists installed apps')
  assert.equal(body.category, 'Software')
  assert.equal(body.max_age_seconds, 3600)
  assert.deepEqual(body.parameters, [{ key: 'flavor', default_value: 'x64' }])
})

test('parametersOf builds key/default_value pairs from a keyvalue field', () => {
  assert.deepEqual(parametersOf({ parameters: { a: '1', b: '2' } }), [
    { key: 'a', default_value: '1' },
    { key: 'b', default_value: '2' },
  ])
  assert.deepEqual(parametersOf({}), [])
})

test('restoreSensorBody rebuilds from a prior sensor', () => {
  const body = restoreSensorBody({
    name: 'P',
    queries: [{ platform: 'Windows', script: 'echo hi', script_type: 'CommandLine' }],
    description: 'd',
    category: 'c',
    max_age_seconds: 60,
    parameters: [{ key: 'k', default_value: 'v' }],
  })
  assert.equal(body.name, 'P')
  assert.equal(body.queries[0].script, 'echo hi')
  assert.equal(body.max_age_seconds, 60)
  assert.deepEqual(body.parameters, [{ key: 'k', default_value: 'v' }])
})

test('restoreSensorBody tolerates a prior sensor with no queries', () => {
  const body = restoreSensorBody({ name: 'Empty' })
  assert.deepEqual(body.queries, [{}])
})

test('primaryQueryOf returns the first query or an empty object', () => {
  assert.deepEqual(primaryQueryOf({ queries: [{ script: 'a' }, { script: 'b' }] }), { script: 'a' })
  assert.deepEqual(primaryQueryOf({}), {})
  assert.deepEqual(primaryQueryOf(null), {})
})

test('parseAdditionalQueries validates shape', () => {
  assert.deepEqual(parseAdditionalQueries('').value, [])
  assert.ok(parseAdditionalQueries('{bad').error)
  assert.ok(parseAdditionalQueries('{}').error) // not an array
  assert.ok(parseAdditionalQueries('[{"platform":"Linux"}]').error) // missing keys
  assert.deepEqual(parseAdditionalQueries('[{"platform":"Linux","script":"x","script_type":"Bash"}]').value, [
    { platform: 'Linux', script: 'x', script_type: 'Bash' },
  ])
})

test('parseNonNegativeInt validates seconds', () => {
  assert.equal(parseNonNegativeInt('0').value, 0)
  assert.equal(parseNonNegativeInt('').value, undefined)
  assert.ok(parseNonNegativeInt('-5').error)
  assert.ok(parseNonNegativeInt('1.5').error)
})

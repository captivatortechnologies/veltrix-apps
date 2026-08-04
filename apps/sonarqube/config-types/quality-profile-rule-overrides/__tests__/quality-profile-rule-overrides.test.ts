import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseParams, formatParams, profilesFromSearch, findProfile, activeRecordFor, normalizeBool } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the SonarQube Web API via node:http(s), which is
 * impractical to mock here. Tests focus on validate.ts and _shared (pure, network-free) —
 * mirrors quality-gates' and quality-profiles' test structure.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `i${i}`, fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const withSeverity = { profileName: 'Veltrix Java', language: 'java', ruleKey: 'java:S1067', severity: 'CRITICAL' }
const withParams = { profileName: 'Veltrix Java', language: 'java', ruleKey: 'java:S1192', params: 'max=5\nmin=1' }

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed item with a severity override', async () => {
  const res = await validate(ctxOf([withSeverity]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a well-formed item with parameter overrides', async () => {
  const res = await validate(ctxOf([withParams]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing profile name', async () => {
  const res = await validate(ctxOf([{ ...withSeverity, profileName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROFILE'))
})

test('validate rejects a missing language', async () => {
  const res = await validate(ctxOf([{ ...withSeverity, language: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LANGUAGE'))
})

test('validate rejects a missing rule key', async () => {
  const res = await validate(ctxOf([{ ...withSeverity, ruleKey: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RULE_KEY'))
})

test('validate warns (not errors) on a malformed rule key', async () => {
  const res = await validate(ctxOf([{ ...withSeverity, ruleKey: 'S1067' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'INVALID_RULE_KEY'))
})

test('validate errors on a malformed params line', async () => {
  const res = await validate(ctxOf([{ ...withParams, params: 'not-a-param' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PARAM'))
})

test('validate warns when reset=true is combined with a severity override', async () => {
  const res = await validate(ctxOf([{ ...withSeverity, reset: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'IGNORED_ON_RESET'))
})

test('validate warns when reset=true is combined with params', async () => {
  const res = await validate(ctxOf([{ ...withParams, reset: true }]))
  assert.ok(res.warnings.some((w) => w.code === 'IGNORED_ON_RESET'))
})

test('validate warns when reset=true is combined with prioritizedRule', async () => {
  const res = await validate(ctxOf([{ profileName: 'P', language: 'java', ruleKey: 'java:S1', reset: true, prioritizedRule: true }]))
  assert.ok(res.warnings.some((w) => w.code === 'IGNORED_ON_RESET'))
})

test('validate does not warn IGNORED_ON_RESET when reset=true is alone', async () => {
  const res = await validate(ctxOf([{ profileName: 'P', language: 'java', ruleKey: 'java:S1', reset: true }]))
  assert.ok(!res.warnings.some((w) => w.code === 'IGNORED_ON_RESET'))
})

test('validate warns on a duplicate (profileName, language, ruleKey) triple', async () => {
  const res = await validate(ctxOf([withSeverity, { ...withSeverity, severity: 'MINOR' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_OVERRIDE'))
})

test('validate allows the same rule key across different profiles or languages', async () => {
  const res = await validate(ctxOf([withSeverity, { ...withSeverity, profileName: 'Other' }, { ...withSeverity, language: 'kotlin' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_OVERRIDE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- parseParams / formatParams -----------------------------------------------

test('parseParams parses key=value lines, ignores blanks / comments', () => {
  const { params, errors } = parseParams('max=5\n\n# a comment\nmin=1')
  assert.deepEqual(params, [
    { key: 'max', value: '5' },
    { key: 'min', value: '1' },
  ])
  assert.equal(errors.length, 0)
})

test('parseParams flags a line with no "=" and a line with an empty key', () => {
  const noEquals = parseParams('not-a-param')
  assert.equal(noEquals.params.length, 0)
  assert.ok(noEquals.errors.some((e) => e.code === 'INVALID_PARAM'))

  const emptyKey = parseParams('=5')
  assert.equal(emptyKey.params.length, 0)
  assert.ok(emptyKey.errors.some((e) => e.code === 'INVALID_PARAM'))
})

test('parseParams allows an empty value (explicit clear)', () => {
  const { params, errors } = parseParams('max=')
  assert.deepEqual(params, [{ key: 'max', value: '' }])
  assert.equal(errors.length, 0)
})

test('formatParams joins parsed params back into the semicolon-separated wire format', () => {
  const { params } = parseParams('max=5\nmin=1')
  assert.equal(formatParams(params), 'max=5;min=1')
  assert.equal(formatParams([]), '')
})

// --- profile search helpers ----------------------------------------------------

test('profilesFromSearch unwraps the profiles envelope', () => {
  assert.equal(profilesFromSearch({ profiles: [{ name: 'A' }, { name: 'B' }] }).length, 2)
  assert.equal(profilesFromSearch({}).length, 0)
  assert.equal(profilesFromSearch(null).length, 0)
})

test('findProfile matches by name + language (language case-insensitive)', () => {
  const profiles = [
    { key: 'AYqPK8dY4JuYVlPqnGQa', name: 'Veltrix', language: 'java' },
    { key: 'other-key', name: 'Veltrix', language: 'js' },
  ]
  assert.equal(findProfile(profiles, 'Veltrix', 'JAVA')?.key, 'AYqPK8dY4JuYVlPqnGQa')
  assert.equal(findProfile(profiles, 'Veltrix', 'js')?.key, 'other-key')
  assert.equal(findProfile(profiles, 'Missing', 'java'), null)
})

// --- activeRecordFor (verified live /api/rules/search?...&f=actives shape) ----

const liveRulesSearchResponse = {
  total: 739,
  p: 1,
  ps: 2,
  rules: [{ key: 'java:S2447', type: 'CODE_SMELL', impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'HIGH' }] }],
  actives: {
    'java:S2447': [
      {
        qProfile: 'AYqPK8dY4JuYVlPqnGQa',
        inherit: 'INHERITED',
        severity: 'CRITICAL',
        params: [],
        createdAt: '2020-01-01T00:00:00+0000',
        updatedAt: '2020-01-01T00:00:00+0000',
        prioritizedRule: false,
        impacts: [],
      },
    ],
    'java:S1192': [
      {
        qProfile: 'AYqPK8dY4JuYVlPqnGQa',
        inherit: 'INHERITED',
        severity: 'CRITICAL',
        params: [
          { key: 'threshold', value: '3' },
          { key: 'minimalLength', value: '5' },
        ],
        createdAt: '2020-01-01T00:00:00+0000',
        updatedAt: '2020-01-01T00:00:00+0000',
        prioritizedRule: false,
        impacts: [],
      },
    ],
  },
}

test('activeRecordFor extracts the first active record for a rule with no params', () => {
  const record = activeRecordFor(liveRulesSearchResponse, 'java:S2447')
  assert.equal(record?.severity, 'CRITICAL')
  assert.equal(record?.inherit, 'INHERITED')
  assert.equal(record?.prioritizedRule, false)
  assert.deepEqual(record?.params, [])
})

test('activeRecordFor extracts the params array for a rule that carries them', () => {
  const record = activeRecordFor(liveRulesSearchResponse, 'java:S1192')
  assert.deepEqual(record?.params, [
    { key: 'threshold', value: '3' },
    { key: 'minimalLength', value: '5' },
  ])
})

test('activeRecordFor returns null when the rule key is entirely absent from actives', () => {
  assert.equal(activeRecordFor(liveRulesSearchResponse, 'java:S9999'), null)
})

test('activeRecordFor returns null (never throws) when actives is missing from the payload', () => {
  assert.equal(activeRecordFor({ total: 0, p: 1, ps: 2, rules: [] }, 'java:S2447'), null)
})

test('activeRecordFor returns null (never throws) on malformed / non-object payloads', () => {
  assert.equal(activeRecordFor(null, 'java:S2447'), null)
  assert.equal(activeRecordFor(undefined, 'java:S2447'), null)
  assert.equal(activeRecordFor('not an object', 'java:S2447'), null)
  assert.equal(activeRecordFor({ actives: 'not an object' }, 'java:S2447'), null)
  assert.equal(activeRecordFor({ actives: { 'java:S2447': [] } }, 'java:S2447'), null)
  assert.equal(activeRecordFor({ actives: { 'java:S2447': 'not an array' } }, 'java:S2447'), null)
})

// --- normalizeBool -------------------------------------------------------------

test('normalizeBool behaves for booleans and common string encodings', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('1'), true)
  assert.equal(normalizeBool('yes'), true)
  assert.equal(normalizeBool(false), false)
  assert.equal(normalizeBool('false'), false)
  assert.equal(normalizeBool(undefined), false)
})

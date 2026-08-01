import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseRuleKeys, profilesFromSearch, findProfile, defaultProfileName, ruleKeysFromSearch, normalizeBool } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the SonarQube Web API via node:http(s), which is
 * impractical to mock here. Tests focus on validate.ts and _shared (pure, network-free).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Veltrix Java', language: 'java', parentName: 'Sonar way', isDefault: false, activateRuleKeys: 'java:S1067' }

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed profile', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing language', async () => {
  const res = await validate(ctxOf([{ ...good, language: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_LANGUAGE'))
})

test('validate rejects a profile that is its own parent', async () => {
  const res = await validate(ctxOf([{ ...good, parentName: 'Veltrix Java' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SELF_PARENT'))
})

test('validate warns on a malformed rule key', async () => {
  const res = await validate(ctxOf([{ ...good, activateRuleKeys: 'not-a-rule-key' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MALFORMED_RULE_KEY'))
})

test('validate warns on a duplicate (name, language) pair', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_PROFILE'))
})

test('validate allows the same name across different languages', async () => {
  const res = await validate(ctxOf([good, { ...good, language: 'js' }]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_PROFILE'))
})

test('validate warns when more than one profile is default for a language', async () => {
  const res = await validate(ctxOf([{ ...good, isDefault: true }, { ...good, name: 'Other', isDefault: true }]))
  assert.ok(res.warnings.some((w) => w.code === 'MULTIPLE_DEFAULT'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- parseRuleKeys -----------------------------------------------------------

test('parseRuleKeys parses keys, ignores blanks / comments, dedupes', () => {
  const { keys, malformed } = parseRuleKeys('java:S1067\n\n# a comment\njava:S1192\njava:S1067')
  assert.deepEqual(keys, ['java:S1067', 'java:S1192'])
  assert.equal(malformed.length, 0)
})

test('parseRuleKeys flags a key without a repository:rule shape', () => {
  const { keys, malformed } = parseRuleKeys('S1067')
  assert.equal(keys.length, 0)
  assert.deepEqual(malformed, ['S1067'])
})

// --- search helpers ----------------------------------------------------------

test('profilesFromSearch unwraps the profiles envelope', () => {
  assert.equal(profilesFromSearch({ profiles: [{ name: 'A' }, { name: 'B' }] }).length, 2)
  assert.equal(profilesFromSearch({}).length, 0)
})

test('findProfile matches by name + language (language case-insensitive)', () => {
  const profiles = [
    { name: 'Veltrix', language: 'java', isDefault: true },
    { name: 'Veltrix', language: 'js', isDefault: false },
  ]
  assert.equal(findProfile(profiles, 'Veltrix', 'JAVA')?.language, 'java')
  assert.equal(findProfile(profiles, 'Veltrix', 'js')?.isDefault, false)
  assert.equal(findProfile(profiles, 'Missing', 'java'), null)
})

test('defaultProfileName finds the default for a language', () => {
  const profiles = [
    { name: 'Sonar way', language: 'java', isDefault: true },
    { name: 'Veltrix', language: 'java', isDefault: false },
    { name: 'Sonar way', language: 'js', isDefault: true },
  ]
  assert.equal(defaultProfileName(profiles, 'java'), 'Sonar way')
  assert.equal(defaultProfileName(profiles, 'py'), null)
})

test('ruleKeysFromSearch collects rule keys and normalizeBool behaves', () => {
  assert.deepEqual(ruleKeysFromSearch({ rules: [{ key: 'java:S1067' }, { key: 'java:S1192' }] }), ['java:S1067', 'java:S1192'])
  assert.deepEqual(ruleKeysFromSearch({}), [])
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool(false), false)
})

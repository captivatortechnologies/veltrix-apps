import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import {
  desiredFromItem,
  buildDefaultSetupPatch,
  restoreBody,
  sortedLanguages,
  parseRepository,
  toStringArray,
} from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.repository ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  repository: 'octo-org/octo-repo',
  state: 'configured',
  query_suite: 'extended',
  threat_model: 'remote_and_local',
  languages: ['python', 'go'],
  runner_type: 'labeled',
  runner_label: 'self-hosted-linux',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing / malformed repository', async () => {
  const res = await validate(ctxOf([{ ...good, repository: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_REPOSITORY'))
  const res2 = await validate(ctxOf([{ ...good, repository: 'no-slash' }]))
  assert.ok(res2.errors.some((e) => e.code === 'INVALID_REPOSITORY'))
})

test('validate accepts a good configuration', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate repository', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_REPOSITORY'))
})

test('validate rejects invalid enums', async () => {
  const res = await validate(ctxOf([{ ...good, state: 'on', query_suite: 'full', threat_model: 'any' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATE'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_QUERY_SUITE'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_THREAT_MODEL'))
})

test('validate warns on an unknown language', async () => {
  const res = await validate(ctxOf([{ ...good, languages: ['python', 'cobol'] }]))
  assert.ok(res.warnings.some((w) => w.code === 'UNKNOWN_LANGUAGE'))
})

test('validate requires a runner label for a labeled runner', async () => {
  const res = await validate(ctxOf([{ ...good, runner_type: 'labeled', runner_label: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'MISSING_RUNNER_LABEL'))
})

// --- _shared ----------------------------------------------------------------

test('parseRepository splits owner/repo and rejects bad input', () => {
  assert.deepEqual(parseRepository('octo-org/octo-repo'), { owner: 'octo-org', repo: 'octo-repo' })
  assert.equal(parseRepository('no-slash'), null)
})

test('toStringArray reads a real array and a comma/newline string', () => {
  assert.deepEqual(toStringArray(['a', 'b']), ['a', 'b'])
  assert.deepEqual(toStringArray('a, b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(toStringArray(''), [])
})

test('desiredFromItem reads identity, enums and languages', () => {
  const d = desiredFromItem(good)
  assert.equal(d.repository, 'octo-org/octo-repo')
  assert.equal(d.state, 'configured')
  assert.deepEqual(d.languages, ['python', 'go'])
  assert.equal(d.runnerType, 'labeled')
  assert.equal(d.runnerLabel, 'self-hosted-linux')
})

test('buildDefaultSetupPatch omits languages when empty and runner fields unless labeled', () => {
  const body = buildDefaultSetupPatch(desiredFromItem({ ...good, languages: [], runner_type: '' }))
  assert.equal('languages' in body, false)
  assert.equal('runner_type' in body, false)
  assert.equal('runner_label' in body, false)
})

test('buildDefaultSetupPatch includes languages and labeled runner fields when set', () => {
  const body = buildDefaultSetupPatch(desiredFromItem(good))
  assert.deepEqual(body.languages, ['python', 'go'])
  assert.equal(body.runner_type, 'labeled')
  assert.equal(body.runner_label, 'self-hosted-linux')
})

test('restoreBody reconstructs a PATCH body from a prior configuration', () => {
  const body = restoreBody({ state: 'not-configured', query_suite: 'default', threat_model: 'remote' })
  assert.equal(body.state, 'not-configured')
  assert.equal('languages' in body, false)
})

test('sortedLanguages is order-independent', () => {
  assert.equal(sortedLanguages(['go', 'python']), sortedLanguages(['python', 'go']))
  assert.notEqual(sortedLanguages(['go']), sortedLanguages(['python']))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildFindingsQuery, buildTriageBody, hasNarrowingFilter, triageSpecFromFields } from '../_shared'
import { findingIds, triagedIssueIds, triagedCount } from '../../../lib/semgrepApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Semgrep REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared / lib helpers — all network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.ruleName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  ruleName: 'ignore-test-fixtures',
  issueType: 'sast',
  fromStatus: 'open',
  targetState: 'ignored',
  triageReason: 'acceptable_risk',
  repos: ['my-org/my-repo'],
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed triage rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing rule name', async () => {
  const res = await validate(ctxOf([{ ...good, ruleName: '' }]))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RULE_NAME'))
})

test('validate rejects a duplicate rule name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, ruleName: 'Ignore-Test-Fixtures' }]))
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_RULE'))
})

test('validate rejects an invalid finding type', async () => {
  const res = await validate(ctxOf([{ ...good, issueType: 'nope' }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ISSUE_TYPE'))
})

test('validate rejects a triage reason when the state is not ignored', async () => {
  const res = await validate(ctxOf([{ ...good, targetState: 'reviewing' }]))
  assert.ok(res.errors.some((e) => e.code === 'REASON_REQUIRES_IGNORED'))
})

test('validate requires a narrowing filter (no repos/rules/severities)', async () => {
  const res = await validate(ctxOf([{ ...good, repos: [] }]))
  assert.ok(res.errors.some((e) => e.code === 'SELECTION_TOO_BROAD'))
})

test('validate accepts a rule filter alone as a narrowing filter', async () => {
  const res = await validate(ctxOf([{ ...good, repos: [], rules: ['javascript.lang.security.audit.xss'] }]))
  assert.equal(res.valid, true)
})

test('validate rejects an invalid severity', async () => {
  const res = await validate(ctxOf([{ ...good, severities: ['sky-high'] }]))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate warns when rule filters are set for a non-sast type', async () => {
  const res = await validate(ctxOf([{ ...good, issueType: 'sca', rules: ['some-rule'] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'RULES_FILTER_IGNORED'))
})

// --- _shared helpers ----------------------------------------------------------

test('buildTriageBody includes only the fields that are set', () => {
  const body = buildTriageBody(triageSpecFromFields(good))
  assert.equal(body.issue_type, 'sast')
  assert.equal(body.new_triage_state, 'ignored')
  assert.equal(body.status, 'open')
  assert.equal(body.new_triage_reason, 'acceptable_risk')
  assert.deepEqual(body.repos, ['my-org/my-repo'])
  assert.equal('new_note' in body, false)
  assert.equal('rules' in body, false)
})

test('buildFindingsQuery mirrors the selection at the source status', () => {
  const q = buildFindingsQuery(triageSpecFromFields({ ...good, severities: ['high', 'critical'] }))
  assert.equal(q.issue_type, 'sast')
  assert.equal(q.status, 'open')
  assert.deepEqual(q.repos, ['my-org/my-repo'])
  assert.deepEqual(q.severities, ['high', 'critical'])
})

test('hasNarrowingFilter is false only when repos, rules and severities are all empty', () => {
  assert.equal(hasNarrowingFilter(triageSpecFromFields({ ...good, repos: [] })), false)
  assert.equal(hasNarrowingFilter(triageSpecFromFields(good)), true)
})

test('triageSpecFromFields lowercases severities and defaults fromStatus to open', () => {
  const spec = triageSpecFromFields({ ...good, severities: ['HIGH'], fromStatus: 'bogus' })
  assert.deepEqual(spec.severities, ['high'])
  assert.equal(spec.fromStatus, 'open')
})

// --- lib response helpers -----------------------------------------------------

test('findingIds and triage response helpers parse numbers defensively', () => {
  assert.deepEqual(findingIds({ status: 200, ok: true, body: '', json: { findings: [{ id: 1 }, { id: '2' }, {}] } }), [1, 2])
  assert.deepEqual(triagedIssueIds({ status: 200, ok: true, body: '', json: { triaged_issues: [3, '4'] } }), [3, 4])
  assert.equal(triagedCount({ status: 200, ok: true, body: '', json: { num_triaged: 7 } }), 7)
})

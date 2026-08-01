import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildSavedQuestionBody, restoreSavedQuestionBody, savedQuestionText, parseQuestionId } from '../_shared'
import { unwrapData, arrayFrom, objectFrom, findByName } from '../../../lib/taniumRestEntity'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Tanium REST v2 API via
 * node:https inside taniumApi/taniumRestEntity, which is impractical to mock here.
 * Tests focus on validate.ts and the pure, network-free helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'All Windows', questionText: 'Get Computer Name from all machines', comment: 'inventory' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a saved question with no question text or id', async () => {
  const res = await validate(ctxOf([{ name: 'Empty', questionText: '', questionId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_QUESTION'))
})

test('validate accepts a saved question with only a Question ID', async () => {
  const res = await validate(ctxOf([{ name: 'ById', questionId: '42' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a non-numeric Question ID', async () => {
  const res = await validate(ctxOf([{ name: 'Bad', questionId: 'abc' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_QUESTION_ID'))
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

test('validate accepts a good question-text item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared body builders --------------------------------------------------

test('buildSavedQuestionBody sends inline question_text when no id', () => {
  const body = buildSavedQuestionBody(good)
  assert.equal(body.name, 'All Windows')
  assert.deepEqual(body.question, { question_text: 'Get Computer Name from all machines' })
})

test('buildSavedQuestionBody prefers the by-id path when questionId is set', () => {
  const body = buildSavedQuestionBody({ name: 'ById', questionText: 'ignored', questionId: '7' })
  assert.deepEqual(body.question, { id: 7 })
})

test('restoreSavedQuestionBody prefers the prior question id', () => {
  const body = restoreSavedQuestionBody({ name: 'X', question: { id: 9, question_text: 'txt' } })
  assert.deepEqual(body.question, { id: 9 })
})

test('restoreSavedQuestionBody falls back to prior text when no id', () => {
  const body = restoreSavedQuestionBody({ name: 'X', question: { query_text: 'legacy text' } })
  assert.deepEqual(body.question, { question_text: 'legacy text' })
})

test('savedQuestionText tolerates question_text and query_text', () => {
  assert.equal(savedQuestionText({ question: { question_text: 'a' } }), 'a')
  assert.equal(savedQuestionText({ question: { query_text: 'b' } }), 'b')
  assert.equal(savedQuestionText(null), '')
})

test('parseQuestionId validates positive integers', () => {
  assert.equal(parseQuestionId('12').value, 12)
  assert.equal(parseQuestionId('').value, undefined)
  assert.ok(parseQuestionId('0').error)
  assert.ok(parseQuestionId('1.5').error)
  assert.ok(parseQuestionId('x').error)
})

// --- generic entity helpers -------------------------------------------------

test('unwrapData unwraps a { data } envelope', () => {
  assert.deepEqual(unwrapData({ data: { id: 1 } }), { id: 1 })
  assert.deepEqual(unwrapData({ id: 1 }), { id: 1 })
})

test('arrayFrom coerces list/envelope/collection-key shapes', () => {
  assert.equal(arrayFrom({ data: [{ id: 1 }, { id: 2 }] }).length, 2)
  assert.equal(arrayFrom({ data: { saved_questions: [{ id: 1 }] } }, 'saved_questions').length, 1)
  assert.equal(arrayFrom({ data: { saved_questions: [{ id: 1 }] } }).length, 1)
  assert.equal(arrayFrom({ nothing: true }).length, 0)
})

test('objectFrom unwraps a single-object envelope', () => {
  assert.equal(objectFrom<{ id?: number }>({ data: { id: 7 } })?.id, 7)
  assert.equal(objectFrom({ data: [1, 2] }), null)
})

test('findByName matches by name case-insensitively', () => {
  const items = [{ id: 1, name: 'All Windows' }, { id: 2, name: 'Linux' }]
  assert.equal(findByName(items, 'all windows')?.id, 1)
  assert.equal(findByName(items, 'macOS'), null)
})

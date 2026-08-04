import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateNoteCommand, buildModifyNoteCommand, buildDeleteNoteCommand, parseNotes } from '../../../lib/gmp/notes'
import { extractSpecs } from '../_shared'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { text: 'Confirmed by the network team', nvtOid: '1.3.6.1.4.1.25623.1.0.12345' }

test('validate rejects missing text', async () => {
  const res = await validate(ctxOf([{ ...good, text: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEXT'))
})

test('validate rejects a malformed NVT OID', async () => {
  const res = await validate(ctxOf([{ ...good, nvtOid: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NVT_OID'))
})

test('validate rejects a malformed port', async () => {
  const res = await validate(ctxOf([{ ...good, port: 'https' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PORT'))
})

test('validate accepts a good note', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- command builders --------------------------------------------------------

test('buildCreateNoteCommand emits text, nvt and optional scope (no severity fields)', () => {
  const xml = buildCreateNoteCommand({ text: 'Confirmed', nvtOid: '1.2.3', hosts: '10.0.0.1', daysActive: -1 })
  assert.ok(xml.includes('<text>Confirmed</text>'))
  assert.ok(xml.includes('<nvt oid="1.2.3"/>'))
  assert.ok(xml.includes('<hosts>10.0.0.1</hosts>'))
  assert.ok(xml.includes('<active>-1</active>'))
  assert.ok(!xml.includes('severity'))
})

test('buildModifyNoteCommand targets by note_id', () => {
  const xml = buildModifyNoteCommand('n1', { text: 'Updated', nvtOid: '1.2.3' })
  assert.equal(xml, '<modify_note note_id="n1"><text>Updated</text><nvt oid="1.2.3"/></modify_note>')
})

test('buildDeleteNoteCommand sets ultimate', () => {
  assert.equal(buildDeleteNoteCommand('n1', true), '<delete_note note_id="n1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseNotes extracts nvt oid and task/result refs', () => {
  const xml = `<get_notes_response><note id="n1">
    <text>Confirmed</text>
    <nvt oid="1.2.3"/>
    <result id="r1"><name>x</name></result>
  </note></get_notes_response>`
  const [n] = parseNotes(xml)
  assert.equal(n.nvtOid, '1.2.3')
  assert.equal(n.resultId, 'r1')
})

// --- _shared helpers -----------------------------------------------------------

test('extractSpecs uses the canvas item id as itemId', () => {
  const items = [{ id: 'note-1', name: 'unused', fields: good }]
  const [spec] = extractSpecs(items)
  assert.equal(spec.itemId, 'note-1')
  assert.equal(spec.text, good.text)
})

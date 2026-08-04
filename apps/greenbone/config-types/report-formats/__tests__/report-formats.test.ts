import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateReportFormatCommand, buildModifyReportFormatCommand, buildDeleteReportFormatCommand, parseReportFormats } from '../../../lib/gmp/reportFormats'
import { extractSpecs } from '../_shared'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const PDF = 'c402cc3e-b531-11e1-9163-406186ea4fc5'

test('validate rejects an item with neither reportFormatId nor cloneFrom', async () => {
  const res = await validate(ctxOf([{ active: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TARGET'))
})

test('validate rejects a non-UUID reportFormatId', async () => {
  const res = await validate(ctxOf([{ reportFormatId: 'pdf' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_REPORT_FORMAT_ID'))
})

test('validate accepts an item with only reportFormatId', async () => {
  const res = await validate(ctxOf([{ reportFormatId: PDF }]))
  assert.equal(res.valid, true)
})

test('validate accepts an item with only cloneFrom', async () => {
  const res = await validate(ctxOf([{ cloneFrom: PDF }]))
  assert.equal(res.valid, true)
})

// --- command builders --------------------------------------------------------

test('buildCreateReportFormatCommand is clone-only (copy, no other fields)', () => {
  assert.equal(buildCreateReportFormatCommand(PDF), `<create_report_format><copy>${PDF}</copy></create_report_format>`)
})

test('buildModifyReportFormatCommand base64-encodes param values', () => {
  const xml = buildModifyReportFormatCommand('rf1', { active: true, name: 'Custom PDF', params: [{ name: 'Background Colour', value: 'red' }] })
  assert.ok(xml.startsWith('<modify_report_format report_format_id="rf1">'))
  assert.ok(xml.includes('<active>1</active>'))
  assert.ok(xml.includes('<name>Custom PDF</name>'))
  assert.ok(xml.includes('<param><name>Background Colour</name><value>cmVk</value></param>')) // base64("red")
})

test('buildDeleteReportFormatCommand sets ultimate', () => {
  assert.equal(buildDeleteReportFormatCommand('rf1', true), '<delete_report_format report_format_id="rf1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseReportFormats decodes base64 param values', () => {
  const xml = `<get_report_formats_response><report_format id="rf1">
    <name>PDF</name>
    <active>1</active>
    <param><name>Background Colour</name><value>cmVk</value></param>
  </report_format></get_report_formats_response>`
  const [r] = parseReportFormats(xml)
  assert.equal(r.active, true)
  assert.equal(r.params['Background Colour'], 'red')
})

// --- _shared helpers -----------------------------------------------------------

test('extractSpecs parses the params keyvalue object into name/value pairs', () => {
  const items = [{ id: 'rf-item-1', name: 'unused', fields: { reportFormatId: PDF, params: { showTable: '1' } } }]
  const [spec] = extractSpecs(items)
  assert.equal(spec.itemId, 'rf-item-1')
  assert.deepEqual(spec.params, [{ name: 'showTable', value: '1' }])
})

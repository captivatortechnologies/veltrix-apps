import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  archiveKey,
  attributesToBody,
  buildArchiveBody,
  extractArchiveSpec,
  findArchiveByName,
  toPayload,
  type ArchiveResource,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const s3Destination = { type: 's3', bucket: 'my-bucket', integration: { account_id: '123456789012', role_name: 'DatadogArchive' } }
const good = { name: 'Nginx Archive', query: 'source:nginx', destination: JSON.stringify(s3Destination), rehydration_tags: ['host'] }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a well-formed S3 archive', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate accepts well-formed GCS and Azure destinations', async () => {
  const gcs = await validate(
    ctxOf([{ ...good, destination: JSON.stringify({ type: 'gcs', bucket: 'b', integration: { client_email: 'x@y.iam.gserviceaccount.com', project_id: 'p' } }) }]),
  )
  assert.equal(gcs.valid, true, JSON.stringify(gcs.errors))

  const azure = await validate(
    ctxOf([{ ...good, destination: JSON.stringify({ type: 'azure', container: 'c', storage_account: 's', integration: { client_id: 'x', tenant_id: 'y' } }) }]),
  )
  assert.equal(azure.valid, true, JSON.stringify(azure.errors))
})

test('validate rejects missing name/query', async () => {
  const res = await validate(ctxOf([{ ...good, name: '', query: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_QUERY'))
})

test('validate requires a destination and rejects malformed JSON', async () => {
  const missing = await validate(ctxOf([{ ...good, destination: '' }]))
  assert.equal(missing.valid, false)
  assert.ok(missing.errors.some((e) => e.code === 'EMPTY_DESTINATION'))

  const bad = await validate(ctxOf([{ ...good, destination: '{not json' }]))
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_DESTINATION_JSON'))
})

test('validate rejects an unsupported destination type', async () => {
  const res = await validate(ctxOf([{ ...good, destination: JSON.stringify({ type: 'ftp' }) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DESTINATION_TYPE'))
})

test('validate rejects a destination missing its required bucket/container key', async () => {
  const res = await validate(ctxOf([{ ...good, destination: JSON.stringify({ type: 's3', integration: {} }) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_DESTINATION_FIELD'))
})

test('validate rejects a destination missing "integration"', async () => {
  const res = await validate(ctxOf([{ ...good, destination: JSON.stringify({ type: 's3', bucket: 'b' }) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_INTEGRATION'))
})

test('validate rejects a negative max scan size', async () => {
  const res = await validate(ctxOf([{ ...good, rehydration_max_scan_size_in_gb: -1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MAX_SCAN_SIZE'))
})

test('validate rejects a duplicate archive name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: good.name.toUpperCase() }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

test('archiveKey normalizes case and whitespace', () => {
  assert.equal(archiveKey('  Nginx Archive '), 'nginx archive')
})

test('findArchiveByName matches case-insensitively', () => {
  const archives: ArchiveResource[] = [{ id: 'a1', attributes: { name: 'Nginx Archive' } }]
  assert.equal(findArchiveByName(archives, 'nginx archive')?.id, 'a1')
  assert.equal(findArchiveByName(archives, 'missing'), null)
})

test('buildArchiveBody only sets rehydration_max_scan_size_in_gb when defined', () => {
  const spec = extractArchiveSpec(good)
  const withSize = buildArchiveBody(spec, s3Destination, 100)
  assert.equal(withSize.rehydration_max_scan_size_in_gb, 100)
  const withoutSize = buildArchiveBody(spec, s3Destination, undefined)
  assert.equal('rehydration_max_scan_size_in_gb' in withoutSize, false)
})

test('attributesToBody rebuilds a body from captured live attributes, defaulting missing fields', () => {
  const body = attributesToBody({ name: 'N', query: 'Q' })
  assert.equal(body.name, 'N')
  assert.deepEqual(body.destination, {})
  assert.deepEqual(body.rehydration_tags, [])
})

test('toPayload wraps the body in the JSON:API envelope', () => {
  const spec = extractArchiveSpec(good)
  const body = buildArchiveBody(spec, s3Destination, undefined)
  const payload = toPayload(body)
  assert.equal(payload.data.type, 'archives')
})

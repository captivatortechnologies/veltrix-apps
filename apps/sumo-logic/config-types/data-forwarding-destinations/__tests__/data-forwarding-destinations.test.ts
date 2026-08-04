import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildDestinationCreateBody,
  buildDestinationUpdateBody,
  buildDestinationRestoreBody,
  destinationsFromList,
  findDestination,
  normalizeBool,
  type DataForwardingDestination,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The network handlers (deploy/rollback/drift/health) apply over the Sumo Logic
 * Management API via `fetch`, which is impractical to mock here. Tests focus on
 * the pure, network-free pieces: validate.ts and _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.destinationName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const roleBased = {
  destinationName: 'archive-bucket',
  bucketName: 'my-sumo-archive',
  authenticationMode: 'RoleBased',
  roleArn: 'arn:aws:iam::123456789012:role/SumoForwarding',
}

const accessKey = {
  destinationName: 'archive-bucket-2',
  bucketName: 'my-sumo-archive-2',
  authenticationMode: 'AccessKey',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'shh',
}

// --- validate ---------------------------------------------------------------

test('validate accepts a well-formed RoleBased destination', async () => {
  const res = await validate(ctxOf([roleBased]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a well-formed AccessKey destination with a warning', async () => {
  const res = await validate(ctxOf([accessKey]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'ACCESS_KEY_MODE'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...roleBased, destinationName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid bucket name', async () => {
  const res = await validate(ctxOf([{ ...roleBased, bucketName: 'INVALID_BUCKET!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_BUCKET_NAME'))
})

test('validate requires roleArn for RoleBased mode', async () => {
  const res = await validate(ctxOf([{ ...roleBased, roleArn: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ROLE_ARN'))
})

test('validate requires accessKeyId and secretAccessKey for AccessKey mode', async () => {
  const res = await validate(ctxOf([{ ...accessKey, accessKeyId: '', secretAccessKey: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACCESS_KEY_ID'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SECRET_ACCESS_KEY'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([roleBased, { ...roleBased, bucketName: 'other-bucket' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

// --- _shared ----------------------------------------------------------------

test('buildDestinationCreateBody includes bucketName', () => {
  const body = buildDestinationCreateBody(roleBased)
  assert.equal(body.bucketName, 'my-sumo-archive')
  assert.equal(body.roleArn, roleBased.roleArn)
})

test('buildDestinationUpdateBody never includes bucketName', () => {
  const body = buildDestinationUpdateBody(roleBased)
  assert.equal('bucketName' in body, false)
})

test('buildDestinationUpdateBody sends accessKeyId/secretAccessKey only for AccessKey mode', () => {
  const body = buildDestinationUpdateBody(accessKey)
  assert.equal(body.accessKeyId, 'AKIAEXAMPLE')
  assert.equal(body.secretAccessKey, 'shh')
  const roleBody = buildDestinationUpdateBody(roleBased)
  assert.equal('accessKeyId' in roleBody, false)
  assert.equal('secretAccessKey' in roleBody, false)
})

test('buildDestinationRestoreBody excludes secrets and bucketName', () => {
  const prior: DataForwardingDestination = {
    id: '1',
    destinationName: 'd',
    bucketName: 'b',
    authenticationMode: 'AccessKey',
    accessKeyId: 'masked',
    secretAccessKey: 'masked',
    enabled: true,
  }
  const body = buildDestinationRestoreBody(prior)
  assert.equal('accessKeyId' in body, false)
  assert.equal('secretAccessKey' in body, false)
  assert.equal('bucketName' in body, false)
  assert.equal(body.destinationName, 'd')
})

test('normalizeBool coerces booleans and strings', () => {
  assert.equal(normalizeBool(true), true)
  assert.equal(normalizeBool('true'), true)
  assert.equal(normalizeBool('no'), false)
})

test('destinationsFromList unwraps the { data: [...] } envelope and bare arrays', () => {
  const dests: DataForwardingDestination[] = [{ id: '1', destinationName: 'a', bucketName: 'b', authenticationMode: 'RoleBased' }]
  assert.deepEqual(destinationsFromList({ data: dests }), dests)
  assert.deepEqual(destinationsFromList(dests), dests)
  assert.deepEqual(destinationsFromList(null), [])
})

test('findDestination matches by name case-insensitively', () => {
  const dests: DataForwardingDestination[] = [{ id: '9', destinationName: 'Archive-Bucket', bucketName: 'b', authenticationMode: 'RoleBased' }]
  assert.equal(findDestination(dests, 'archive-bucket')?.id, '9')
  assert.equal(findDestination(dests, 'missing'), null)
})

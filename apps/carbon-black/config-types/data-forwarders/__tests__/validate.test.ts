import validate, { extractForwarderSpecs } from '../validate'
import { buildBody, definitionEquals, immutableChanged } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('data-forwarders validate', () => {
  it('accepts a valid S3 alert forwarder', () => {
    const r = validate(ctxWith([{ name: 'F', fields: { name: 'F', type: 'alert', destination: 'aws_s3', s3BucketName: 'my-bucket' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'alert', destination: 'aws_s3', s3BucketName: 'b' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid type and destination', () => {
    const t = validate(ctxWith([{ name: 'F', fields: { name: 'F', type: 'weird', destination: 'aws_s3', s3BucketName: 'b' } }]))
    expect(t.errors.some((e) => e.code === 'invalid_type')).toBe(true)
    const d = validate(ctxWith([{ name: 'F', fields: { name: 'F', type: 'alert', destination: 'nope' } }]))
    expect(d.errors.some((e) => e.code === 'invalid_destination')).toBe(true)
  })

  it('requires the destination-specific bucket fields', () => {
    const s3 = validate(ctxWith([{ name: 'F', fields: { name: 'F', type: 'alert', destination: 'aws_s3' } }]))
    expect(s3.errors.some((e) => e.code === 'missing_bucket')).toBe(true)
    const az = validate(ctxWith([{ name: 'F', fields: { name: 'F', type: 'alert', destination: 'azure_blob_storage' } }]))
    expect(az.errors.some((e) => e.code === 'missing_storage_account')).toBe(true)
    expect(az.errors.some((e) => e.code === 'missing_container')).toBe(true)
  })

  it('flags a duplicate forwarder name', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { name: 'Dup', type: 'alert', destination: 'aws_s3', s3BucketName: 'b' } },
        { name: 'B', fields: { name: 'dup', type: 'alert', destination: 'aws_s3', s3BucketName: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('buildBody / immutableChanged / definitionEquals', () => {
  it('builds an S3 body and detects immutable changes', () => {
    const spec = extractForwarderSpecs(
      ctxWith([{ name: 'F', fields: { name: 'F', type: 'alert', destination: 'aws_s3', enabled: true, s3BucketName: 'b', s3Prefix: 'p' } }]).canvas
    )[0]
    const body = buildBody(spec) as { name: string; type: string; destination: string; s3_bucket_name: string; s3_prefix: string }
    expect(body.type).toBe('alert')
    expect(body.destination).toBe('aws_s3')
    expect(body.s3_bucket_name).toBe('b')
    expect(body.s3_prefix).toBe('p')
    expect(immutableChanged({ type: 'auditlog', destination: 'aws_s3' }, spec)).toBe(true)
    expect(immutableChanged({ type: 'alert', destination: 'aws_s3' }, spec)).toBe(false)
    expect(definitionEquals({ type: 'alert', destination: 'aws_s3', enabled: true, s3_bucket_name: 'b', s3_prefix: 'p' }, spec)).toBe(true)
    expect(definitionEquals({ type: 'alert', destination: 'aws_s3', enabled: false, s3_bucket_name: 'b', s3_prefix: 'p' }, spec)).toBe(false)
  })
})

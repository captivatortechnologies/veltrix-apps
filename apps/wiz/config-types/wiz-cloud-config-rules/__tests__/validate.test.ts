import validate, { extractCloudConfigRuleSpecs, ruleKey, readBool, strList } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-cloud-config-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-cloud-config-rules',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = {
  name: 'S3 buckets must be private',
  severity: 'HIGH',
  target_native_types: ['aws.s3.bucket'],
  opa_policy: 'package wiz\n\ndefault result = "fail"',
}

describe('Wiz Cloud Configuration Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name, target native types and a Rego policy', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { severity: 'LOW' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('target_native_types'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('opa_policy'))).toBe(true)
  })

  it('rejects an unsupported severity', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, severity: 'BLOCKER' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('requires IaC Rego code when an IaC matcher type is selected', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, iac_matcher_type: 'TERRAFORM' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('iac_rego_code'))).toBe(true)
  })

  it('rejects an unsupported IaC matcher type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, iac_matcher_type: 'PULUMI', iac_rego_code: 'package x' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_iac_matcher_type')).toBe(true)
  })

  it('rejects IaC Rego code with no matcher type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, iac_rego_code: 'package x' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('iac_matcher_type'))).toBe(true)
  })

  it('accepts a valid IaC matcher pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { ...validFields, iac_matcher_type: 'TERRAFORM', iac_rego_code: 'package iac' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate rule names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Public Bucket' } },
        { name: 'b', fields: { ...validFields, name: 'public bucket' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('extractCloudConfigRuleSpecs defaults, trims and reads lists/booleans', () => {
    const specs = extractCloudConfigRuleSpecs(
      makeCtx([
        {
          name: 'e',
          fields: {
            name: '  Rule Y  ',
            target_native_types: 'aws.s3.bucket, aws.ec2.instance',
            opa_policy: '  package p  ',
            function_as_control: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Rule Y')
    expect(specs[0].severity).toBe('MEDIUM')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].functionAsControl).toBe(true)
    expect(specs[0].targetNativeTypes).toEqual(['aws.s3.bucket', 'aws.ec2.instance'])
    expect(specs[0].opaPolicy).toBe('package p')
    expect(specs[0].iacMatcherType).toBe('none')
    expect(ruleKey('  Rule Y ')).toBe('rule y')
  })

  it('readBool and strList behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readBool(false, true)).toBe(false)
    expect(strList(['a', ' b '])).toEqual(['a', 'b'])
    expect(strList('a,b, ')).toEqual(['a', 'b'])
  })
})

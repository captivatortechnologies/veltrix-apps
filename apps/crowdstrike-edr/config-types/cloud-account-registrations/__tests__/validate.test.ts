import validate, {
  accountIdentity,
  extractAccountSpecs,
  liveAccountIdentity,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'cloud-account-registrations',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-account-registrations',
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

const SUBSCRIPTION_ID = '11111111-1111-1111-1111-111111111111'
const TENANT_ID = '22222222-2222-2222-2222-222222222222'

function validAwsFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cloudProvider: 'aws',
    accountId: '123456789012',
    accountType: 'commercial',
    iamRoleArn: 'arn:aws:iam::123456789012:role/FalconCSPM',
    regions: 'us-east-1',
    behaviorAssessmentEnabled: true,
    ...overrides,
  }
}

function validAzureFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cloudProvider: 'azure',
    subscriptionId: SUBSCRIPTION_ID,
    tenantId: TENANT_ID,
    accountType: 'commercial',
    defaultSubscription: true,
    ...overrides,
  }
}

function validGcpFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cloudProvider: 'gcp',
    projectId: 'my-project-123',
    accountType: 'commercial',
    ...overrides,
  }
}

describe('CrowdStrike Cloud Account Registrations Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid AWS account registration', async () => {
    const result = await validate(makeCtx([{ name: 'Account', fields: validAwsFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid Azure subscription registration', async () => {
    const result = await validate(makeCtx([{ name: 'Account', fields: validAzureFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid GCP project registration', async () => {
    const result = await validate(makeCtx([{ name: 'Account', fields: validGcpFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing cloud provider', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validAwsFields({ cloudProvider: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unknown cloud provider', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validAwsFields({ cloudProvider: 'oracle' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_provider')).toBe(true)
  })

  it('requires an AWS account ID', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validAwsFields({ accountId: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('accountId'))).toBe(true)
  })

  it('rejects a malformed AWS account ID', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validAwsFields({ accountId: '123' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('requires an Azure tenant ID', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validAzureFields({ tenantId: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('tenantId'))).toBe(true)
  })

  it('rejects a malformed Azure subscription GUID', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validAzureFields({ subscriptionId: 'not-a-guid' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format' && e.field.includes('subscriptionId'))).toBe(
      true,
    )
  })

  it('rejects a malformed GCP project ID', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGcpFields({ projectId: 'X' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects an invalid account type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validAwsFields({ accountType: 'enterprise' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_account_type')).toBe(true)
  })

  it('rejects a duplicate account of the same provider', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validAwsFields() },
        { name: 'sec2', fields: validAwsFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_account')).toBe(true)
  })

  it('allows the same id across different providers', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validAwsFields() },
        { name: 'sec2', fields: validAzureFields() },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns that CSPM cannot be turned off here', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validAwsFields({ cspmEnabled: false }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'cspm_base_capability')).toBe(true)
  })

  it('always warns that onboarding requires an out-of-band setup step', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validAwsFields() }]))
    expect(result.warnings.some((w) => w.code === 'requires_out_of_band_setup')).toBe(true)
  })

  it('warns when an AWS account has no IAM role ARN', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validAwsFields({ iamRoleArn: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_iam_role')).toBe(true)
  })

  it('warns when a foreign-provider field is populated', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validAzureFields({ iamRoleArn: 'arn:aws:iam::123456789012:role/X' }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'field_ignored')).toBe(true)
  })
})

describe('extractAccountSpecs', () => {
  it('normalizes provider casing, lowercases Azure ids, and coerces booleans', () => {
    const specs = extractAccountSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-account-registrations',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            cloudProvider: 'AWS',
            accountId: '123456789012',
            behaviorAssessmentEnabled: 'true',
            dspmEnabled: false,
          },
        },
        {
          name: 'sec2',
          fields: { cloudProvider: 'Azure', subscriptionId: SUBSCRIPTION_ID.toUpperCase() },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].cloudProvider).toBe('aws')
    expect(specs[0].behaviorAssessmentEnabled).toBe(true)
    expect(specs[0].dspmEnabled).toBe(false)
    // cspmEnabled defaults to true (base capability)
    expect(specs[0].cspmEnabled).toBe(true)
    expect(specs[1].cloudProvider).toBe('azure')
    expect(specs[1].subscriptionId).toBe(SUBSCRIPTION_ID)
  })
})

describe('accountIdentity / liveAccountIdentity', () => {
  it('returns the provider id used to find the account', () => {
    expect(accountIdentity(extractAccountSpecs(single(validAwsFields()))[0])).toBe('123456789012')
    expect(accountIdentity(extractAccountSpecs(single(validAzureFields()))[0])).toBe(SUBSCRIPTION_ID)
    expect(accountIdentity(extractAccountSpecs(single(validGcpFields()))[0])).toBe('my-project-123')
  })

  it('reads the provider id back off a live resource, incl. GCP parent_id', () => {
    expect(liveAccountIdentity('aws', { account_id: '123456789012' })).toBe('123456789012')
    expect(liveAccountIdentity('azure', { subscription_id: SUBSCRIPTION_ID })).toBe(SUBSCRIPTION_ID)
    expect(liveAccountIdentity('gcp', { parent_id: 'my-project-123' })).toBe('my-project-123')
  })
})

function single(fields: Record<string, unknown>) {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'crowdstrike-edr',
    entityType: 'cloud-account-registrations',
    items: [],
    sections: [{ name: 'sec1', fields }],
    snapshot: {},
  }
}

import validate, { assembleRrules, extractScanSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

/** A valid Tenable scan template uuid (standard 8-4-4-4-12 layout). */
const TEMPLATE_UUID = '731a8e52-3ea6-a291-ec0a-d2ff0619c19d'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'scans',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'scans',
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

describe('Tenable VM Scans Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid on-demand scan', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Scan',
          fields: {
            name: 'western-region-assets',
            templateUuid: TEMPLATE_UUID,
            textTargets: '10.0.0.0/24, host.example.com',
            launch: 'ON_DEMAND',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid weekly scan', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Scan',
          fields: {
            name: 'weekly-prod-scan',
            templateUuid: TEMPLATE_UUID,
            policyId: 123,
            textTargets: '10.0.0.0/24',
            launch: 'WEEKLY',
            starttime: '20240117T130000',
            timezone: 'US/Mountain',
            interval: 1,
            byday: ['MO', 'WE', 'FR'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing scan name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { templateUuid: TEMPLATE_UUID, textTargets: '10.0.0.1', launch: 'ON_DEMAND' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing template uuid', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 's1', textTargets: '10.0.0.1', launch: 'ON_DEMAND' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('templateUuid'))).toBe(true)
  })

  it('rejects a malformed template uuid', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 's1', templateUuid: 'not-a-uuid', textTargets: '10.0.0.1', launch: 'ON_DEMAND' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_uuid')).toBe(true)
  })

  it('rejects missing targets', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 's1', templateUuid: TEMPLATE_UUID, launch: 'ON_DEMAND' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('textTargets'))).toBe(true)
  })

  it('rejects an unknown launch cadence', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 's1', templateUuid: TEMPLATE_UUID, textTargets: '10.0.0.1', launch: 'HOURLY' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_launch')).toBe(true)
  })

  it('rejects a bad starttime format on a scheduled scan', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 's1',
            templateUuid: TEMPLATE_UUID,
            textTargets: '10.0.0.1',
            launch: 'WEEKLY',
            starttime: '2024-01-17 13:00:00',
            byday: ['MO'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_starttime')).toBe(true)
  })

  it('rejects invalid byday tokens', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 's1',
            templateUuid: TEMPLATE_UUID,
            textTargets: '10.0.0.1',
            launch: 'WEEKLY',
            starttime: '20240117T130000',
            byday: ['MO', 'FUNDAY'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_byday')).toBe(true)
  })

  it('rejects a non-positive policy id', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 's1', templateUuid: TEMPLATE_UUID, textTargets: '10.0.0.1', launch: 'ON_DEMAND', policyId: 0 },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy_id')).toBe(true)
  })

  it('rejects duplicate scan names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Nightly', templateUuid: TEMPLATE_UUID, textTargets: '10.0.0.1', launch: 'ON_DEMAND' } },
        { name: 'sec2', fields: { name: 'nightly', templateUuid: TEMPLATE_UUID, textTargets: '10.0.0.2', launch: 'ON_DEMAND' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('assembleRrules', () => {
  it('builds a WEEKLY rrules string from interval and byday', () => {
    expect(assembleRrules('WEEKLY', 1, 'MO,WE,FR')).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR')
  })

  it('honours a non-default interval', () => {
    expect(assembleRrules('DAILY', 3)).toBe('FREQ=DAILY;INTERVAL=3')
  })

  it('omits BYDAY for non-weekly cadences', () => {
    expect(assembleRrules('MONTHLY', 1, 'MO,WE')).toBe('FREQ=MONTHLY;INTERVAL=1')
  })

  it('produces no rrules for an on-demand scan', () => {
    expect(assembleRrules('ON_DEMAND', 1, 'MO,WE,FR')).toBeUndefined()
  })
})

describe('extractScanSpecs', () => {
  it('trims fields, normalizes targets/byday, and drops empty optionals', () => {
    const specs = extractScanSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'scans',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  nightly  ',
            templateUuid: `  ${TEMPLATE_UUID}  `,
            description: '  ',
            textTargets: '10.0.0.1\n10.0.0.2,  host.example.com',
            launch: 'weekly',
            byday: 'mo, we',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('nightly')
    expect(specs[0].templateUuid).toBe(TEMPLATE_UUID)
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].textTargets).toBe('10.0.0.1,10.0.0.2,host.example.com')
    expect(specs[0].launch).toBe('WEEKLY')
    expect(specs[0].byday).toBe('MO,WE')
  })
})

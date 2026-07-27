import validate, { extractPutFileSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'rtr-put-files',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'rtr-put-files',
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

function validPutFileFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'remediation-cleanup.ps1',
    description: 'Cleanup script staged to hosts during IR',
    content: 'Remove-Item -Recurse -Force C:\\Temp\\malware',
    ...overrides,
  }
}

describe('CrowdStrike RTR Put-Files Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid put-file configuration', async () => {
    const result = await validate(makeCtx([{ name: 'PutFile', fields: validPutFileFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing put-file name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPutFileFields({ name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing description', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPutFileFields({ description: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('description'))).toBe(
      true,
    )
  })

  it('rejects empty file content', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPutFileFields({ content: '   ' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('content'))).toBe(true)
  })

  it('rejects duplicate put-file names across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validPutFileFields() },
        { name: 'sec2', fields: validPutFileFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an over-long audit-log comment', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPutFileFields({ commentsForAuditLog: 'x'.repeat(4097) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects an over-long put-file name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validPutFileFields({ name: 'n'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })
})

describe('extractPutFileSpecs', () => {
  it('trims name/description and preserves content verbatim', () => {
    const specs = extractPutFileSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'rtr-put-files',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  cleanup.sh  ',
            description: '  staged cleanup  ',
            content: '  rm -rf /tmp/x  ',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('cleanup.sh')
    expect(specs[0].description).toBe('staged cleanup')
    expect(specs[0].content).toBe('  rm -rf /tmp/x  ')
    expect(specs[0].commentsForAuditLog).toBeUndefined()
  })

  it('defaults missing fields to empty strings', () => {
    const specs = extractPutFileSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'rtr-put-files',
      items: [],
      sections: [{ name: 'sec1', fields: {} }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('')
    expect(specs[0].description).toBe('')
    expect(specs[0].content).toBe('')
  })
})

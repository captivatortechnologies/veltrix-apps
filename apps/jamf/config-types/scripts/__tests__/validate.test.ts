import validate, {
  buildScriptBody,
  extractScriptSpecs,
  indexScriptsByName,
  scriptKey,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'scripts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'scripts',
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
  name: 'Install Rosetta',
  priority: 'AFTER',
  script_contents: '#!/bin/zsh\nsoftwareupdate --install-rosetta --agree-to-license\n',
}

describe('Jamf Scripts Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid script', async () => {
    const result = await validate(makeCtx([{ name: 'Script', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { priority: 'AFTER', script_contents: 'echo hi' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported priority', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, priority: 'WHENEVER' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_priority')).toBe(true)
  })

  it('requires non-empty script contents', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Empty Script', priority: 'AFTER', script_contents: '' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('script_contents'))).toBe(true)
  })

  it('rejects duplicate script names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Enroll Setup' } },
        { name: 'b', fields: { ...validFields, name: 'enroll setup' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_script')).toBe(true)
  })

  it('defaults priority to AFTER when a spec omits it', () => {
    const specs = extractScriptSpecs(
      makeCtx([{ name: 'e', fields: { name: 'No Priority', script_contents: 'echo hi' } }]).canvas,
    )
    expect(specs[0].priority).toBe('AFTER')
  })

  it('extractScriptSpecs trims values and reads parameter fields', () => {
    const specs = extractScriptSpecs(
      makeCtx([
        {
          name: 'e',
          fields: { name: '  My Script  ', script_contents: 'echo hi', parameter4: '  --flag  ', parameter11: 'x' },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('My Script')
    expect(specs[0].parameter4).toBe('--flag')
    expect(specs[0].parameter5).toBe('')
    expect(specs[0].parameter11).toBe('x')
    expect(scriptKey('  My Script ')).toBe('my script')
  })

  it('buildScriptBody omits categoryName when unset and includes every parameter key', () => {
    const specs = extractScriptSpecs(makeCtx([{ name: 'e', fields: validFields }]).canvas)
    const body = buildScriptBody(specs[0])
    expect(body.categoryName).toBeUndefined()
    expect(body.name).toBe('Install Rosetta')
    expect(body.parameter4).toBe('')
    expect(body.parameter11).toBe('')
  })

  it('buildScriptBody includes categoryName when set', () => {
    const specs = extractScriptSpecs(
      makeCtx([{ name: 'e', fields: { ...validFields, category_name: 'Enrollment' } }]).canvas,
    )
    const body = buildScriptBody(specs[0])
    expect(body.categoryName).toBe('Enrollment')
  })

  it('indexScriptsByName is case-insensitive and first-match-wins on duplicates', () => {
    const byName = indexScriptsByName([
      { id: '1', name: 'Dup' },
      { id: '2', name: 'dup' },
      { id: '3', name: 'Unique' },
    ])
    expect(byName.get('dup')?.id).toBe('1')
    expect(byName.get('unique')?.id).toBe('3')
    expect(byName.size).toBe(2)
  })
})

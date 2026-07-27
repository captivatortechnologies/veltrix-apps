import validate, {
  extractITTaskSpecs,
  parseTaskParameters,
  parameterKeys,
  buildTaskContent,
  readLiveContent,
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
    configTypeId: 'it-automation-tasks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'it-automation-tasks',
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

function validTaskFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Collect Running Processes',
    description: 'Reads the running process list',
    taskType: 'query',
    platforms: 'windows, linux',
    content: 'SELECT name, pid FROM processes;',
    ...overrides,
  }
}

describe('CrowdStrike IT Automation Tasks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid task configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Task', fields: validTaskFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing task name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validTaskFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unknown task type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTaskFields({ taskType: 'destroy' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_task_type')).toBe(true)
  })

  it('requires at least one platform', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTaskFields({ platforms: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('platforms'))).toBe(true)
  })

  it('rejects unknown platforms', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTaskFields({ platforms: 'windows, solaris' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_platform')).toBe(true)
  })

  it('requires content', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTaskFields({ content: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('content'))).toBe(true)
  })

  it('rejects invalid parameters JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validTaskFields({ parameters: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_parameters')).toBe(true)
  })

  it('rejects a parameter without a key', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validTaskFields({ parameters: JSON.stringify([{ label: 'x' }]) }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_parameters')).toBe(true)
  })

  it('accepts a valid remediation task', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validTaskFields({ taskType: 'remediation', content: 'Restart-Service Spooler' }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate task names across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validTaskFields() },
        { name: 'sec2', fields: validTaskFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseTaskParameters', () => {
  it('accepts an array of keyed objects', () => {
    const { parameters, errors } = parseTaskParameters(
      JSON.stringify([{ key: 'a', label: 'A' }, { key: 'b' }]),
    )
    expect(errors).toHaveLength(0)
    expect(parameters).toHaveLength(2)
  })

  it('rejects duplicate keys', () => {
    const { errors } = parseTaskParameters(JSON.stringify([{ key: 'a' }, { key: 'a' }]))
    expect(errors.some((e) => e.includes('more than once'))).toBe(true)
  })

  it('returns empty for empty input', () => {
    expect(parseTaskParameters('')).toEqual({ parameters: [], errors: [] })
  })

  it('exposes parameter keys', () => {
    const { parameters } = parseTaskParameters(JSON.stringify([{ key: 'a' }, { key: 'b' }]))
    expect(parameterKeys(parameters)).toEqual(['a', 'b'])
  })
})

describe('buildTaskContent / readLiveContent', () => {
  it('maps a query task to os_query', () => {
    const content = buildTaskContent({
      sectionName: 's',
      name: 't',
      taskType: 'query',
      platforms: ['windows'],
      content: 'SELECT 1;',
      parametersRaw: '',
    })
    expect(content).toEqual({ os_query: 'SELECT 1;' })
  })

  it('maps a remediation task to per-platform remediations', () => {
    const content = buildTaskContent({
      sectionName: 's',
      name: 't',
      taskType: 'remediation',
      platforms: ['windows', 'linux'],
      content: 'echo hi',
      parametersRaw: '',
    })
    expect(content).toEqual({
      remediations: { windows: { content: 'echo hi' }, linux: { content: 'echo hi' } },
    })
  })

  it('reads the live osquery content back for a query task', () => {
    const live = readLiveContent(
      { sectionName: 's', name: 't', taskType: 'query', platforms: ['windows'], content: 'x', parametersRaw: '' },
      { os_query: 'SELECT 2;' },
    )
    expect(live).toBe('SELECT 2;')
  })

  it('reads the live remediation content for the first matching platform', () => {
    const live = readLiveContent(
      { sectionName: 's', name: 't', taskType: 'remediation', platforms: ['linux'], content: 'x', parametersRaw: '' },
      { remediations: { linux: { content: 'echo live' } } },
    )
    expect(live).toBe('echo live')
  })
})

describe('extractITTaskSpecs', () => {
  it('lowercases platforms and task type', () => {
    const specs = extractITTaskSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'it-automation-tasks',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 't1', taskType: 'QUERY', platforms: 'Windows, MAC' } }],
      snapshot: {},
    })
    expect(specs[0].taskType).toBe('query')
    expect(specs[0].platforms).toEqual(['windows', 'mac'])
  })
})

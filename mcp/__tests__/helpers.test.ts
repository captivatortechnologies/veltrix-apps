import {
  DEFAULT_MAX_RESULT_CHARS,
  DESTRUCTIVE,
  READ,
  WRITE,
  WRITE_IDEMPOTENT,
  capResultText,
  maxResultChars,
  reachesTenantTools,
  runTool,
} from '../src/tools/helpers';
import { VeltrixApiError } from '../src/veltrix-client';

describe('capResultText', () => {
  it('returns short text unchanged', () => {
    expect(capResultText('{"ok":true}', 100)).toBe('{"ok":true}');
  });

  it('truncates long text and says how to narrow the request', () => {
    const capped = capResultText('a'.repeat(500), 100);
    expect(capped).toContain('the response was 500 characters; showing the first 100');
    expect(capped).toContain('page/limit');
    expect(capped.endsWith('a'.repeat(100))).toBe(true);
  });
});

describe('maxResultChars', () => {
  const original = process.env.VELTRIX_MCP_MAX_RESULT_CHARS;

  afterEach(() => {
    if (original === undefined) delete process.env.VELTRIX_MCP_MAX_RESULT_CHARS;
    else process.env.VELTRIX_MCP_MAX_RESULT_CHARS = original;
  });

  it('defaults when unset or invalid', () => {
    delete process.env.VELTRIX_MCP_MAX_RESULT_CHARS;
    expect(maxResultChars()).toBe(DEFAULT_MAX_RESULT_CHARS);
    process.env.VELTRIX_MCP_MAX_RESULT_CHARS = 'lots';
    expect(maxResultChars()).toBe(DEFAULT_MAX_RESULT_CHARS);
  });

  it('honours a configured limit', () => {
    process.env.VELTRIX_MCP_MAX_RESULT_CHARS = '1234';
    expect(maxResultChars()).toBe(1234);
  });
});

describe('runTool', () => {
  it('serializes data as pretty JSON and passes strings through', async () => {
    expect(await runTool(async () => ({ a: 1 }))).toEqual({ content: [{ type: 'text', text: '{\n  "a": 1\n}' }] });
    expect(await runTool(async () => 'plain')).toEqual({ content: [{ type: 'text', text: 'plain' }] });
    expect(await runTool(async () => undefined)).toEqual({ content: [{ type: 'text', text: 'null' }] });
  });

  it('turns API errors into readable isError results', async () => {
    const result = await runTool(async () => {
      throw VeltrixApiError.from(404, { error: 'Canvas not found' });
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Canvas not found');
  });

  it('labels unexpected errors', async () => {
    const result = await runTool(async () => {
      throw new Error('boom');
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe('Unexpected error calling the Veltrix API: boom');
  });
});

describe('annotation presets', () => {
  it('are internally consistent', () => {
    expect(READ).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(WRITE.readOnlyHint).toBe(false);
    expect(WRITE.destructiveHint).toBe(false);
    expect(WRITE_IDEMPOTENT.idempotentHint).toBe(true);
    expect(DESTRUCTIVE.destructiveHint).toBe(true);
  });

  it('reachesTenantTools flips only openWorldHint and does not mutate the preset', () => {
    expect(reachesTenantTools(WRITE)).toEqual({ ...WRITE, openWorldHint: true });
    expect(WRITE.openWorldHint).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { Finding } from '@/openai/schema';
import {
  type CodeFetcher,
  type CompleteFn,
  type ModelStep,
  type ParsedToolCall,
  sliceWithLineNumbers,
  verifyFindingsWithTools,
  verifyOneWithTools,
} from '@/openai/verify-tools';

const finding: Finding = {
  file: 'lib/http.js',
  line: 875,
  severity: 'warning',
  category: 'bug',
  message: 'The own() helper mutates its argument.',
  confidence: 0.9,
};
const fileDiff = [{ filename: 'lib/http.js', patch: '@@ -1 +1 @@\n+const x = own(a);' }];

function fakeFetcher(over: Partial<CodeFetcher> = {}): CodeFetcher {
  return {
    readFile: async () => 'definition body',
    findFiles: async () => ['lib/utils.js'],
    ...over,
  };
}

function tc(name: string, args: object, id = 'call-1'): ParsedToolCall {
  return { id, name, args: JSON.stringify(args) };
}

function step(toolCalls: ParsedToolCall[]): ModelStep {
  return {
    message: { role: 'assistant', content: '' },
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
  };
}

// A scripted model that returns successive steps and counts its calls.
function scripted(steps: ModelStep[]): { complete: CompleteFn; state: { calls: number } } {
  const state = { calls: 0 };
  const complete: CompleteFn = async () => {
    const s = steps[state.calls];
    state.calls += 1;
    if (!s) throw new Error('script exhausted');
    return s;
  };
  return { complete, state };
}

describe('sliceWithLineNumbers', () => {
  it('numbers lines 1-based and bounds the range', () => {
    expect(sliceWithLineNumbers('a\nb\nc\nd', 2, 4)).toBe('2: b\n3: c\n4: d');
  });

  it('appends a remaining-lines note when the slice is truncated', () => {
    const out = sliceWithLineNumbers('a\nb\nc', 1, 1);
    expect(out).toContain('1: a');
    expect(out).toContain('(2 more lines)');
  });

  it('reports when the start is past the end of the file', () => {
    expect(sliceWithLineNumbers('a\nb', 9)).toMatch(/only 2 lines/);
  });
});

describe('verifyOneWithTools', () => {
  it('runs a tool call then returns the submitted verdict', async () => {
    const reads: string[] = [];
    const fetcher = fakeFetcher({
      readFile: async (p) => {
        reads.push(p);
        return 'real def';
      },
    });
    const { complete, state } = scripted([
      step([tc('read_file', { path: 'lib/utils.js' })]),
      step([
        tc('submit_verdict', { verdict: 'false_positive', reason: 'definition contradicts it' }),
      ]),
    ]);
    const res = await verifyOneWithTools({ finding, fileDiff, fetcher, complete, model: 'm' });
    expect(res.verdict.verdict).toBe('false_positive');
    expect(res.verdict.reason).toBe('definition contradicts it');
    expect(reads).toEqual(['lib/utils.js']);
    expect(res.toolLog[0]).toContain('read_file lib/utils.js');
    expect(state.calls).toBe(2);
    // usage accumulates across both turns
    expect(res.usage.inputTokens).toBe(20);
  });

  it('lets the model find then read a file across turns', async () => {
    const found: string[] = [];
    const fetcher = fakeFetcher({
      findFiles: async (q) => {
        found.push(q);
        return ['lib/utils.js', 'lib/other.js'];
      },
    });
    const { complete } = scripted([
      step([tc('find_files', { query: 'utils' })]),
      step([tc('read_file', { path: 'lib/utils.js', start_line: 1, end_line: 5 })]),
      step([tc('submit_verdict', { verdict: 'real', reason: 'confirmed in source' })]),
    ]);
    const res = await verifyOneWithTools({ finding, fileDiff, fetcher, complete, model: 'm' });
    expect(res.verdict.verdict).toBe('real');
    expect(found).toEqual(['utils']);
    expect(res.toolLog).toEqual(['find_files utils', 'read_file lib/utils.js:1-5']);
  });

  it('fails open when the model never submits within the iteration budget', async () => {
    const complete: CompleteFn = async () => step([tc('read_file', { path: 'a' })]);
    const res = await verifyOneWithTools({
      finding,
      fileDiff,
      fetcher: fakeFetcher(),
      complete,
      model: 'm',
      maxIters: 3,
    });
    expect(res.verdict.verdict).toBe('error');
    expect(res.verdict.reason).toMatch(/budget/);
  });

  it('still accepts a verdict on the final forced-submit turn', async () => {
    // Reads on turn 0, then submits on turn 1, which is the last turn allowed at
    // maxIters 2 and the turn the loop forces a decision on.
    const { complete } = scripted([
      step([tc('read_file', { path: 'a' })]),
      step([
        tc('submit_verdict', { verdict: 'false_positive', reason: 'decided under the deadline' }),
      ]),
    ]);
    const res = await verifyOneWithTools({
      finding,
      fileDiff,
      fetcher: fakeFetcher(),
      complete,
      model: 'm',
      maxIters: 2,
    });
    expect(res.verdict.verdict).toBe('false_positive');
  });

  it('fails open when the model call throws', async () => {
    const complete: CompleteFn = async () => {
      throw new Error('gateway 502');
    };
    const res = await verifyOneWithTools({
      finding,
      fileDiff,
      fetcher: fakeFetcher(),
      complete,
      model: 'm',
    });
    expect(res.verdict.verdict).toBe('error');
    expect(res.verdict.reason).toContain('gateway 502');
  });

  it('fails open when the model answers with prose instead of a tool call', async () => {
    const complete: CompleteFn = async () => step([]);
    const res = await verifyOneWithTools({
      finding,
      fileDiff,
      fetcher: fakeFetcher(),
      complete,
      model: 'm',
    });
    expect(res.verdict.verdict).toBe('error');
    expect(res.verdict.reason).toMatch(/submit_verdict/);
  });

  it('treats invalid submit_verdict arguments as an error', async () => {
    const complete: CompleteFn = async () => step([tc('submit_verdict', { verdict: 'maybe' })]);
    const res = await verifyOneWithTools({
      finding,
      fileDiff,
      fetcher: fakeFetcher(),
      complete,
      model: 'm',
    });
    expect(res.verdict.verdict).toBe('error');
  });

  it('surfaces a tool error to the model rather than throwing', async () => {
    const fetcher = fakeFetcher({
      readFile: async () => {
        throw new Error('404 not found');
      },
    });
    const { complete } = scripted([
      step([tc('read_file', { path: 'missing.js' })]),
      step([tc('submit_verdict', { verdict: 'real', reason: 'kept after a failed read' })]),
    ]);
    const res = await verifyOneWithTools({ finding, fileDiff, fetcher, complete, model: 'm' });
    // The loop did not throw; it recovered and reached a verdict.
    expect(res.verdict.verdict).toBe('real');
  });
});

describe('verifyFindingsWithTools', () => {
  const patchByFile = new Map<string, string | undefined>([['lib/http.js', fileDiff[0].patch]]);

  it('drops a finding the verifier refutes', async () => {
    const refute: CompleteFn = async () =>
      step([tc('submit_verdict', { verdict: 'false_positive', reason: 'r' })]);
    const res = await verifyFindingsWithTools(
      [finding],
      patchByFile,
      'm',
      fakeFetcher(),
      6,
      refute,
    );
    expect(res.dropped).toHaveLength(1);
    expect(res.kept).toHaveLength(0);
  });

  it('keeps a finding the verifier confirms real', async () => {
    const confirm: CompleteFn = async () =>
      step([tc('submit_verdict', { verdict: 'real', reason: 'r' })]);
    const res = await verifyFindingsWithTools(
      [finding],
      patchByFile,
      'm',
      fakeFetcher(),
      6,
      confirm,
    );
    expect(res.kept).toHaveLength(1);
    expect(res.dropped).toHaveLength(0);
  });

  it('fails open and keeps a finding whose file has no patch, without calling the model', async () => {
    const never: CompleteFn = async () => {
      throw new Error('the model must not be called for a patchless finding');
    };
    const res = await verifyFindingsWithTools([finding], new Map(), 'm', fakeFetcher(), 6, never);
    expect(res.kept).toHaveLength(1);
    expect(res.errorCount).toBe(1);
  });
});

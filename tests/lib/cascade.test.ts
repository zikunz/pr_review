import { describe, expect, it } from 'vitest';
import { CASCADE_DEFAULTS, decideCascadeTier, selectReviewModel } from '@/lib/cascade';

const cfg = CASCADE_DEFAULTS;

// Helper: build a file entry. Use the real filename so isDocsFile classifies it
// correctly based on extension/basename — do not use a generic 'file.ts' for
// everything, since the classification depends on the actual filename.
const file = (filename: string, chars = 100) => ({ filename, patch: 'x'.repeat(chars) });

// ---------- Tier 1 — docs/prose/media only ----------

describe('Tier 1: docs/prose/media-only diff', () => {
  it('single Markdown file → Tier 1', () => {
    const d = decideCascadeTier([file('README.md')], cfg);
    expect(d.tier).toBe(1);
    expect(d.model).toBe(cfg.tier1Model);
    expect(d.codeFileCount).toBe(0);
    expect(d.docsFileCount).toBe(1);
  });

  it('multiple prose files → Tier 1', () => {
    const d = decideCascadeTier(
      [file('README.md'), file('CHANGELOG.md'), file('docs/setup.rst')],
      cfg,
    );
    expect(d.tier).toBe(1);
    expect(d.docsFileCount).toBe(3);
  });

  it('SVG image → Tier 1', () => {
    expect(decideCascadeTier([file('logo.svg')], cfg).tier).toBe(1);
  });

  it('PNG image → Tier 1', () => {
    expect(decideCascadeTier([file('assets/icon.png')], cfg).tier).toBe(1);
  });

  it('AsciiDoc file → Tier 1', () => {
    expect(decideCascadeTier([file('docs/guide.adoc')], cfg).tier).toBe(1);
  });

  it('plain text file → Tier 1', () => {
    expect(decideCascadeTier([file('LICENSE.txt')], cfg).tier).toBe(1);
  });

  // Lock files matched by DOCS_BASENAMES, not by extension.
  it('yarn.lock → Tier 1 (matched by basename)', () => {
    expect(decideCascadeTier([file('yarn.lock')], cfg).tier).toBe(1);
  });

  it('package-lock.json → Tier 1 (matched by basename, NOT by .json extension)', () => {
    // package-lock.json is in DOCS_BASENAMES; it is NOT routed to Tier 1 via
    // the .json extension (which is intentionally absent from DOCS_EXTENSIONS).
    expect(decideCascadeTier([file('package-lock.json')], cfg).tier).toBe(1);
  });

  it('pnpm-lock.yaml → Tier 1 (matched by basename)', () => {
    expect(decideCascadeTier([file('pnpm-lock.yaml')], cfg).tier).toBe(1);
  });

  it('Cargo.lock → Tier 1 (matched by basename)', () => {
    expect(decideCascadeTier([file('Cargo.lock')], cfg).tier).toBe(1);
  });

  it('go.sum → Tier 1 (matched by basename)', () => {
    expect(decideCascadeTier([file('go.sum')], cfg).tier).toBe(1);
  });

  it('.env.example → Tier 1 (matched by basename)', () => {
    // .env.example is in DOCS_BASENAMES. The extension fallback would yield
    // '.example', which is NOT in DOCS_EXTENSIONS. Basename match is required.
    expect(decideCascadeTier([file('.env.example')], cfg).tier).toBe(1);
  });

  it('.gitignore → Tier 1 (matched by basename)', () => {
    // .gitignore is in DOCS_BASENAMES. A PR that only changes .gitignore is
    // docs-like and correctly routed to Tier 1.
    const d = decideCascadeTier([file('.gitignore')], cfg);
    expect(d.tier).toBe(1);
    expect(d.docsFileCount).toBe(1);
    expect(d.codeFileCount).toBe(0);
  });

  it('.gitattributes → Tier 1 (matched by basename)', () => {
    expect(decideCascadeTier([file('.gitattributes')], cfg).tier).toBe(1);
  });

  it('.editorconfig → Tier 1 (matched by basename)', () => {
    expect(decideCascadeTier([file('.editorconfig')], cfg).tier).toBe(1);
  });

  // The critical case: package.json must NOT be Tier 1.
  it('one code + one doc file → NOT Tier 1 (code file present)', () => {
    const d = decideCascadeTier([file('src/main.ts'), file('README.md')], cfg);
    expect(d.tier).not.toBe(1);
    expect(d.codeFileCount).toBe(1);
    expect(d.docsFileCount).toBe(1);
  });
});

// ---------- Tier 1 safety: JSON/YAML/TOML configs are NOT docs ----------

describe('JSON/YAML/TOML executable config files → NOT Tier 1', () => {
  // package.json has scripts, dependencies, exports — executable config.
  it('package.json → Tier 2 (NOT docs — executable config)', () => {
    const d = decideCascadeTier([file('package.json')], cfg);
    expect(d.tier).toBe(2);
    expect(d.codeFileCount).toBe(1);
  });

  it('tsconfig.json → Tier 2 (NOT docs)', () => {
    expect(decideCascadeTier([file('tsconfig.json')], cfg).tier).toBe(2);
  });

  it('jest.config.json → Tier 2 (NOT docs)', () => {
    expect(decideCascadeTier([file('jest.config.json')], cfg).tier).toBe(2);
  });

  it('.github/workflows/ci.yml → Tier 2 (NOT docs — CI config has executable semantics)', () => {
    expect(decideCascadeTier([file('.github/workflows/ci.yml')], cfg).tier).toBe(2);
  });

  it('Cargo.toml → Tier 2 (NOT docs — has scripts and feature flags)', () => {
    expect(decideCascadeTier([file('Cargo.toml')], cfg).tier).toBe(2);
  });

  it('pyproject.toml → Tier 2 (NOT docs)', () => {
    expect(decideCascadeTier([file('pyproject.toml')], cfg).tier).toBe(2);
  });
});

// ---------- Tier 2 — code, small diff ----------

describe('Tier 2: small code diff', () => {
  it('single small TypeScript file → Tier 2', () => {
    const d = decideCascadeTier([file('src/foo.ts', 500)], cfg);
    expect(d.tier).toBe(2);
    expect(d.model).toBe(cfg.tier2Model);
  });

  it('multiple code files, total within threshold → Tier 2', () => {
    const d = decideCascadeTier(
      [file('src/a.ts', 2000), file('src/b.py', 2000), file('src/c.go', 2000)],
      cfg,
    );
    expect(d.totalPatchChars).toBe(6000);
    expect(d.tier).toBe(2);
  });

  it('exactly at threshold → Tier 2 (threshold is inclusive)', () => {
    const d = decideCascadeTier([file('src/a.ts', cfg.tier2MaxChars)], cfg);
    expect(d.tier).toBe(2);
  });

  it('Python file → Tier 2', () => {
    expect(decideCascadeTier([file('main.py', 100)], cfg).tier).toBe(2);
  });

  it('Java file → Tier 2', () => {
    expect(decideCascadeTier([file('Main.java', 100)], cfg).tier).toBe(2);
  });

  it('Rust source file → Tier 2', () => {
    expect(decideCascadeTier([file('lib.rs', 100)], cfg).tier).toBe(2);
  });

  it('multi-dot code filename (foo.test.ts) → Tier 2', () => {
    // ext = '.ts', not in DOCS_EXTENSIONS → code
    const d = decideCascadeTier([file('src/foo.test.ts', 100)], cfg);
    expect(d.codeFileCount).toBe(1);
    expect(d.tier).toBe(2);
  });

  it('minified file (foo.min.js) → Tier 2', () => {
    // ext = '.js', not in DOCS_EXTENSIONS → code
    const d = decideCascadeTier([file('dist/app.min.js', 100)], cfg);
    expect(d.codeFileCount).toBe(1);
    expect(d.tier).toBe(2);
  });

  it('deeply nested path → Tier 2', () => {
    // Tests that path-stripping via split('/').pop() works correctly.
    const d = decideCascadeTier([file('packages/core/src/utils/helpers.ts', 100)], cfg);
    expect(d.codeFileCount).toBe(1);
    expect(d.tier).toBe(2);
  });

  it('mixed code + docs, small → Tier 2 (code forces ≥ Tier 2)', () => {
    const d = decideCascadeTier([file('src/a.ts', 100), file('README.md', 100)], cfg);
    expect(d.tier).toBe(2);
    expect(d.codeFileCount).toBe(1);
    expect(d.docsFileCount).toBe(1);
  });
});

// ---------- Tier 3 — large code diff ----------

describe('Tier 3: large code diff', () => {
  it('single large TypeScript file → Tier 3', () => {
    const d = decideCascadeTier([file('src/foo.ts', cfg.tier2MaxChars + 1)], cfg);
    expect(d.tier).toBe(3);
    expect(d.model).toBe(cfg.tier3Model);
  });

  it('multiple code files exceeding threshold → Tier 3', () => {
    const d = decideCascadeTier([file('a.ts', 5000), file('b.ts', 5000)], cfg);
    expect(d.totalPatchChars).toBe(10000);
    expect(d.tier).toBe(3);
  });

  it('one byte over threshold → Tier 3', () => {
    const d = decideCascadeTier([file('x.ts', cfg.tier2MaxChars + 1)], cfg);
    expect(d.tier).toBe(3);
  });
});

// ---------- Edge cases ----------

describe('Edge cases', () => {
  it('empty file list → Tier 1 (no code files; handler hasPatch guard prevents this in practice)', () => {
    // codeFileCount=0, docsFileCount=0 → Tier 1 by vacuous truth.
    // In production, handler.ts returns early when filesWithPatch.length === 0
    // before decideCascadeTier is ever called, so this path is unreachable in prod.
    const d = decideCascadeTier([], cfg);
    expect(d.tier).toBe(1);
    expect(d.codeFileCount).toBe(0);
    expect(d.docsFileCount).toBe(0);
    expect(d.totalPatchChars).toBe(0);
  });

  it('custom config overrides model slugs', () => {
    const custom = { ...cfg, tier1Model: 'openai/gpt-5.4-mini' };
    expect(decideCascadeTier([file('README.md')], custom).model).toBe('openai/gpt-5.4-mini');
  });

  it('custom tier2MaxChars = 1 sends any non-trivial code diff to Tier 3', () => {
    const custom = { ...cfg, tier2MaxChars: 1 };
    const d = decideCascadeTier([file('src/a.ts', 2)], custom);
    expect(d.tier).toBe(3);
  });

  it('reason field is a non-empty string', () => {
    const d = decideCascadeTier([file('src/a.ts', 100)], cfg);
    expect(typeof d.reason).toBe('string');
    expect(d.reason.length).toBeGreaterThan(0);
  });

  it('file without extension (Makefile, Dockerfile) → code → Tier 2', () => {
    // Files with no extension have no extension to match, so they are code.
    const d = decideCascadeTier([{ filename: 'Makefile', patch: 'x'.repeat(100) }], cfg);
    expect(d.codeFileCount).toBe(1);
    expect(d.tier).toBe(2);
  });

  it('pure dotfile not in DOCS_BASENAMES (.hidden) → code → Tier 2', () => {
    // .hidden: phase1 miss (not in DOCS_BASENAMES), lastDot=0 → returns false.
    // Classified as code — correct: unknown dotfiles may have executable content.
    const d = decideCascadeTier([{ filename: '.hidden', patch: 'x'.repeat(100) }], cfg);
    expect(d.codeFileCount).toBe(1);
    expect(d.tier).toBe(2);
  });

  it('uppercase extension .MD → Tier 1 (case-insensitive)', () => {
    const d = decideCascadeTier([{ filename: 'README.MD', patch: 'x'.repeat(100) }], cfg);
    expect(d.tier).toBe(1);
  });

  it('stats are correctly accumulated across files', () => {
    const d = decideCascadeTier(
      [file('src/a.ts', 1000), file('docs/guide.md', 500), file('src/b.ts', 2000)],
      cfg,
    );
    expect(d.codeFileCount).toBe(2);
    expect(d.docsFileCount).toBe(1);
    expect(d.totalPatchChars).toBe(3500);
  });

  it('large docs-only diff → Tier 1 regardless of patch size', () => {
    // A 100k-char Markdown diff is still Tier 1. The handler's
    // MAX_PROMPT_DIFF_CHARS (200k) bounds the upper end in production.
    const d = decideCascadeTier([file('LARGE_DOC.md', 100_000)], cfg);
    expect(d.tier).toBe(1);
    expect(d.codeFileCount).toBe(0);
  });
});

// ---------- selectReviewModel — the handler wiring ----------

describe('selectReviewModel: cascade on/off wiring', () => {
  const flat = 'openai/gpt-5.4-mini';

  it('cascade disabled → uses the flat model, cascade is null', () => {
    const sel = selectReviewModel(false, flat, [file('src/big.ts', 50_000)], cfg);
    expect(sel.model).toBe(flat);
    expect(sel.cascade).toBeNull();
  });

  it('cascade disabled → flat model used even for a docs-only diff', () => {
    const sel = selectReviewModel(false, flat, [file('README.md')], cfg);
    expect(sel.model).toBe(flat);
    expect(sel.cascade).toBeNull();
  });

  it('cascade enabled, docs-only → Tier 1 model, cascade populated', () => {
    const sel = selectReviewModel(true, flat, [file('README.md')], cfg);
    expect(sel.model).toBe(cfg.tier1Model);
    expect(sel.cascade?.tier).toBe(1);
  });

  it('cascade enabled, small code diff → Tier 2 model', () => {
    const sel = selectReviewModel(true, flat, [file('src/a.ts', 500)], cfg);
    expect(sel.model).toBe(cfg.tier2Model);
    expect(sel.cascade?.tier).toBe(2);
  });

  it('cascade enabled, large code diff → Tier 3 model', () => {
    const sel = selectReviewModel(true, flat, [file('src/a.ts', cfg.tier2MaxChars + 1)], cfg);
    expect(sel.model).toBe(cfg.tier3Model);
    expect(sel.cascade?.tier).toBe(3);
  });

  it('cascade enabled → selection model always equals the cascade decision model', () => {
    const sel = selectReviewModel(true, flat, [file('src/a.ts', 500)], cfg);
    expect(sel.model).toBe(sel.cascade?.model);
  });

  it('cascade enabled but flat model never leaks into the selection', () => {
    const sel = selectReviewModel(true, flat, [file('src/a.ts', 500)], cfg);
    expect(sel.model).not.toBe(flat);
  });
});

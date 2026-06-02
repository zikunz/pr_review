// Cascade routing for v0.2. Classifies a pull request diff into one of three
// tiers and returns the model slug to use for that tier.
//
// Classification is intentionally based on objective diff signals (file
// extensions and patch size) rather than on model output. Making the tier
// decision without calling any LLM keeps latency low and avoids the recursive
// cost of calling a model just to decide which model to call.
//
// Tier 1, docs/prose only. Every changed file is human-readable text,
//   media, or a lock file with no executable semantics. Fine for README
//   edits, changelogs, image updates, and dependency lock bumps.
//
// Tier 2, code changes, small diff (≤ CASCADE_TIER2_MAX_CHARS patch chars).
//   Standard review. Handles the majority of routine code PRs.
//
// Tier 3, code changes, large diff (> CASCADE_TIER2_MAX_CHARS patch chars).
//   Full-power review. Large refactors, cross-file changes, security-sensitive
//   diffs that benefit from a frontier model.
//
// Note: `totalPatchChars` is the sum over ALL files in the diff, including any
// docs files mixed into a code PR. Because Tier 1 is only reached when
// `codeFileCount === 0`, the Tier 2/3 threshold is effectively applied to the
// code-only patch size in practice (docs chars are additive but negligible for
// a pure code PR). The handler's own MAX_PROMPT_DIFF_CHARS gate (200 000 chars)
// bounds the upper end before this function is ever called.

// Exact base-names that are unambiguously docs or generated non-code assets.
// These are checked BEFORE the extension fallback so that multi-dot names like
// `package-lock.json` land here explicitly and are not confused with
// `package.json` (which has executable semantics and is intentionally excluded).
const DOCS_BASENAMES = new Set([
  // Lock files are generated, with no executable semantics authored by humans.
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum', // Go module checksum database, generated, not authored
  // Template / example env files, not live config.
  '.env.example',
  '.env.sample',
  '.env.template',
  // Common dotfiles with no executable content.
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.editorconfig',
  '.prettierignore',
  '.eslintignore',
  '.npmignore',
  '.dockerignore',
]);

// File extensions that indicate prose documentation or binary media assets.
// `.json`, `.yaml`, `.toml`, etc. are deliberately EXCLUDED here because those
// extensions cover both pure-config files (docs-like) AND executable-config
// files like `package.json`, `tsconfig.json`, `jest.config.json`, `Cargo.toml`,
// etc. Using the DOCS_BASENAMES set above for known-safe JSON/YAML names is the
// correct approach. Adding an entire extension to this set would silently route
// all JSON PRs (including dependency/script changes) to the cheapest model.
const DOCS_EXTENSIONS = new Set([
  // Prose documentation
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc', // AsciiDoc
  // Data / reporting (no executable semantics)
  '.csv',
  // Image and font assets
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

// Returns true when the filename is docs/media only (Tier 1 eligible).
// Two-phase check:
//   Phase 1, full basename match against DOCS_BASENAMES (covers lock files,
//              dotfiles, and multi-dot names like `package-lock.json`).
//   Phase 2, last-extension match against DOCS_EXTENSIONS (covers prose and
//              media by extension, e.g. `.md`, `.png`).
// A file with no extension (e.g. `Makefile`, `Dockerfile`, `Procfile`) is
// classified as code because it contains executable content.
function isDocsFile(filename: string): boolean {
  const base = filename.split('/').pop() ?? filename;

  // Phase 1: exact basename match (handles lock files and dotfiles).
  if (DOCS_BASENAMES.has(base)) return true;

  // Phase 2: last-extension match.
  const lastDot = base.lastIndexOf('.');
  if (lastDot === -1) return false; // no extension → code
  if (lastDot === 0) return false; // pure dotfile (e.g. `.hidden`) → code
  const ext = base.slice(lastDot).toLowerCase();
  return DOCS_EXTENSIONS.has(ext);
}

export type CascadeTier = 1 | 2 | 3;

export interface CascadeDecision {
  tier: CascadeTier;
  model: string;
  // Human-readable reason for the tier decision. Goes into the trace log.
  reason: string;
  totalPatchChars: number;
  codeFileCount: number;
  docsFileCount: number;
}

export interface CascadeConfig {
  tier1Model: string;
  tier2Model: string;
  tier3Model: string;
  // Total patch character threshold (all files) that divides Tier 2 from Tier 3.
  tier2MaxChars: number;
}

// Default config. Individual fields are overridable via env vars in env.ts.
export const CASCADE_DEFAULTS: CascadeConfig = {
  tier1Model: 'openai/gpt-5.4-mini',
  tier2Model: 'openai/gpt-5.4',
  tier3Model: 'openai/gpt-5.5',
  tier2MaxChars: 8_000,
};

export interface ModelSelection {
  // The model slug to use for the base review.
  model: string;
  // The cascade decision when routing was enabled, else null (flat model).
  cascade: CascadeDecision | null;
}

/**
 * Decide which base-review model to use for a PR.
 *
 * Pure function over the cascade toggle, the flat fallback model, and the diff.
 * Centralizes the "cascade on -> tier model, cascade off -> flat model" wiring
 * so it can be unit-tested without the handler's IO. The handler calls this and
 * then passes `selection.model` to callReview and logs `selection.cascade`.
 *
 * @param enabled   Whether cascade routing is enabled (env.CASCADE_ENABLED).
 * @param flatModel The model to use when cascade is disabled (env.OPENAI_MODEL).
 * @param files     The PR files with patches.
 * @param config    Cascade tier config (model slugs + threshold).
 */
export function selectReviewModel(
  enabled: boolean,
  flatModel: string,
  files: Array<{ filename: string; patch: string }>,
  config: CascadeConfig,
): ModelSelection {
  if (!enabled) {
    return { model: flatModel, cascade: null };
  }
  const cascade = decideCascadeTier(files, config);
  return { model: cascade.model, cascade };
}

/**
 * Classify a set of PR files into a cascade tier.
 *
 * Pure function, no IO, no side effects, fully testable.
 *
 * @param files  Array of {filename, patch} pairs (only files with a patch).
 * @param config Tier model slugs and the Tier 2 patch-size threshold.
 * @returns CascadeDecision with the tier number, model slug, and supporting stats.
 */
export function decideCascadeTier(
  files: Array<{ filename: string; patch: string }>,
  config: CascadeConfig,
): CascadeDecision {
  let codeFileCount = 0;
  let docsFileCount = 0;
  let totalPatchChars = 0;

  for (const f of files) {
    totalPatchChars += f.patch.length;
    if (isDocsFile(f.filename)) {
      docsFileCount++;
    } else {
      codeFileCount++;
    }
  }

  // Tier 1: every changed file is docs/media (including an empty file list,
  // which the handler's hasPatch guard prevents in practice).
  if (codeFileCount === 0) {
    return {
      tier: 1,
      model: config.tier1Model,
      reason: `docs/media-only diff (${docsFileCount} files, ${totalPatchChars} chars)`,
      totalPatchChars,
      codeFileCount,
      docsFileCount,
    };
  }

  // Tier 2: code files present, total patch within threshold.
  if (totalPatchChars <= config.tier2MaxChars) {
    return {
      tier: 2,
      model: config.tier2Model,
      reason: `code diff within tier-2 threshold (${codeFileCount} code files, ${totalPatchChars} chars ≤ ${config.tier2MaxChars})`,
      totalPatchChars,
      codeFileCount,
      docsFileCount,
    };
  }

  // Tier 3: code files present, total patch above threshold.
  return {
    tier: 3,
    model: config.tier3Model,
    reason: `large code diff above tier-2 threshold (${codeFileCount} code files, ${totalPatchChars} chars > ${config.tier2MaxChars})`,
    totalPatchChars,
    codeFileCount,
    docsFileCount,
  };
}

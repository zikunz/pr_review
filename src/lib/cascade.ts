// Cascade routing for v0.2. Classifies a pull request diff into one of three
// tiers and returns the model slug to use for that tier.
//
// Classification is intentionally based on objective diff signals (file
// extensions and patch size) rather than on model output. Making the tier
// decision without calling any LLM keeps latency low and avoids the recursive
// cost of calling a model just to decide which model to call.
//
// Tier 1 — docs/config only. Every changed file has a non-code extension.
//   Fast, cheap. Fine for README edits, YAML tweaks, lock-file bumps.
//
// Tier 2 — code changes, small diff (≤ CASCADE_TIER2_MAX_CHARS patch chars).
//   Standard review. Handles the majority of routine code PRs.
//
// Tier 3 — code changes, large diff (> CASCADE_TIER2_MAX_CHARS patch chars).
//   Full-power review. Large refactors, cross-file changes, security-sensitive
//   diffs that benefit from a frontier model.

// File extensions that indicate documentation or configuration rather than
// executable source code. A PR is Tier 1 only when EVERY changed file matches
// this set — a single code file forces escalation to Tier 2 or 3.
const DOCS_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc', // AsciiDoc
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env.example',
  '.lock', // lock files (package-lock.json, yarn.lock, Cargo.lock)
  '.csv',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
]);

// Returns true when the filename is docs/config only (Tier 1 eligible).
// Uses the full filename so multi-dot names like `.env.example` resolve
// correctly, then falls back to the last extension segment.
function isDocsFile(filename: string): boolean {
  // Match against the full filename (for dotfiles like `.gitignore`)
  const base = filename.split('/').pop() ?? filename;
  if (DOCS_EXTENSIONS.has(base)) return true;

  // Match against the extension. Use lastIndexOf so `.env.example` yields
  // `.env.example` when checking the full base, and `.example` as fallback.
  const lastDot = base.lastIndexOf('.');
  if (lastDot === -1) return false;
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
  // Patch character threshold that divides Tier 2 from Tier 3.
  tier2MaxChars: number;
}

// Default config. Individual fields are overridable via env vars in env.ts.
export const CASCADE_DEFAULTS: CascadeConfig = {
  tier1Model: 'openai/gpt-5.3-codex',
  tier2Model: 'openai/gpt-5.4',
  tier3Model: 'openai/gpt-5.5',
  tier2MaxChars: 8_000,
};

/**
 * Classify a set of PR files into a cascade tier.
 *
 * Pure function — no IO, no side effects, fully testable.
 *
 * @param files Array of {filename, patch} pairs (only files with a patch).
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

  // Tier 1: every changed file is docs/config.
  if (codeFileCount === 0) {
    return {
      tier: 1,
      model: config.tier1Model,
      reason: `docs/config-only diff (${docsFileCount} files, ${totalPatchChars} chars)`,
      totalPatchChars,
      codeFileCount,
      docsFileCount,
    };
  }

  // Tier 2: code files present, within patch-size threshold.
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

  // Tier 3: code files present, above patch-size threshold.
  return {
    tier: 3,
    model: config.tier3Model,
    reason: `large code diff above tier-2 threshold (${codeFileCount} code files, ${totalPatchChars} chars > ${config.tier2MaxChars})`,
    totalPatchChars,
    codeFileCount,
    docsFileCount,
  };
}

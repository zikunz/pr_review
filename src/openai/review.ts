import OpenAI from 'openai';
import { ContentFilterFinishReasonError, LengthFinishReasonError } from 'openai/error';
import { zodResponseFormat } from 'openai/helpers/zod';
import { getEnv } from '@/env';
import { buildUserPrompt, type PromptFile, SYSTEM_PROMPT } from './prompt';
import type { ReviewOutput as ReviewOutputType } from './schema';
import { ReviewOutput } from './schema';

let cachedClient: OpenAI | undefined;

// Exported so the verification gate (src/openai/verify.ts) reuses the same
// cached client and OpenRouter routing rather than constructing its own.
export function client(): OpenAI {
  if (cachedClient) return cachedClient;
  const env = getEnv();
  // Explicit 60s ceiling so a slow response cannot pin a review promise for
  // the lifetime of the container. The SDK's default has shifted across
  // versions, so set it here rather than rely on whatever ships.
  const options: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: env.OPENAI_API_KEY,
    timeout: 60_000,
  };
  // When OPENAI_BASE_URL points at an OpenAI-compatible gateway (OpenRouter),
  // route through it. OpenRouter reads two optional attribution headers for
  // its app-ranking leaderboard; they are ignored by OpenAI and other
  // gateways, so only attach them when the URL is actually OpenRouter.
  if (env.OPENAI_BASE_URL) {
    options.baseURL = env.OPENAI_BASE_URL;
    if (env.OPENAI_BASE_URL.includes('openrouter.ai')) {
      options.defaultHeaders = {
        'HTTP-Referer': 'https://github.com/zikunz/pr_review',
        'X-Title': 'PR Cascade',
      };
    }
  }
  cachedClient = new OpenAI(options);
  return cachedClient;
}

export interface ReviewCallInput {
  prTitle: string;
  prBody: string | null;
  files: PromptFile[];
  model?: string;
}

export interface ReviewCallResult {
  review: ReviewOutputType;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  model: string;
}

export class ReviewTruncatedError extends Error {
  constructor(public readonly model: string) {
    super('OpenAI hit the output length limit before completing the review');
    this.name = 'ReviewTruncatedError';
  }
}

export class ReviewContentFilteredError extends Error {
  constructor(public readonly model: string) {
    super('OpenAI content filter blocked the review output');
    this.name = 'ReviewContentFilteredError';
  }
}

export class ReviewRefusedError extends Error {
  constructor(
    public readonly model: string,
    public readonly refusal: string,
  ) {
    super(`OpenAI refused the request for model ${model}`);
    this.name = 'ReviewRefusedError';
  }
}

// Cap the completion length so a single review cannot drain the budget on
// output tokens alone. The Zod schema asks for at most five findings, and
// even generous per-finding messages comfortably fit under 4000 tokens of
// completion, so this ceiling does not truncate legitimate reviews. The
// per-review cost cap still gates the post-call spend, but the post-call
// gate cannot prevent the spend itself. Only this pre-call ceiling can.
const MAX_COMPLETION_TOKENS = 4000;

export async function callReview(input: ReviewCallInput): Promise<ReviewCallResult> {
  const model = input.model ?? getEnv().OPENAI_MODEL;
  const completion = await client()
    .chat.completions.parse({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      response_format: zodResponseFormat(ReviewOutput, 'pr_review'),
      max_completion_tokens: MAX_COMPLETION_TOKENS,
    })
    .catch((err: unknown) => {
      if (err instanceof LengthFinishReasonError) throw new ReviewTruncatedError(model);
      if (err instanceof ContentFilterFinishReasonError) {
        throw new ReviewContentFilteredError(model);
      }
      throw err;
    });

  if (completion.choices.length === 0) {
    throw new Error(`OpenAI returned no choices for model ${model}`);
  }
  const message = completion.choices[0]?.message;
  if (message?.refusal) {
    throw new ReviewRefusedError(model, message.refusal);
  }
  if (!message?.parsed) {
    throw new Error(`OpenAI returned no parsed review payload for model ${model}`);
  }

  const usage = completion.usage;
  return {
    review: message.parsed,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model,
  };
}

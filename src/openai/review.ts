import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { getEnv } from '@/env';
import { buildUserPrompt, type PromptFile, SYSTEM_PROMPT } from './prompt';
import type { ReviewOutput as ReviewOutputType } from './schema';
import { ReviewOutput } from './schema';

let cachedClient: OpenAI | undefined;

function client(): OpenAI {
  if (cachedClient) return cachedClient;
  const env = getEnv();
  cachedClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
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

const DEFAULT_MODEL = 'gpt-5.3-codex';

export async function callReview(input: ReviewCallInput): Promise<ReviewCallResult> {
  const model = input.model ?? DEFAULT_MODEL;
  const completion = await client().chat.completions.parse({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) },
    ],
    response_format: zodResponseFormat(ReviewOutput, 'pr_review'),
  });

  const message = completion.choices[0]?.message;
  if (message?.refusal) {
    throw new Error(`OpenAI refused the request: ${message.refusal}`);
  }
  if (!message?.parsed) {
    throw new Error('OpenAI returned no parsed review payload');
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

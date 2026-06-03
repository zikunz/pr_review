import { zodResponseFormat } from 'openai/helpers/zod';
import { buildUserPrompt, type PromptFile, WALKTHROUGH_SYSTEM_PROMPT } from './prompt';
import { client } from './review';
import { type WalkthroughItem, WalkthroughOutput } from './schema';

// Generous ceiling so a reasoning-capable model finishes before emitting the
// small structured list.
const MAX_WALKTHROUGH_TOKENS = 4000;

// Generate a high-level walkthrough of the change in a dedicated call, separate
// from the line-level review. The walkthrough is advisory, so any failure
// (network, truncation, gateway error, or a model that returns nothing) yields
// an empty list rather than blocking the review.
export async function generateWalkthrough(
  input: { prTitle: string; prBody: string | null; files: PromptFile[] },
  model: string,
): Promise<WalkthroughItem[]> {
  try {
    const completion = await client().chat.completions.parse({
      model,
      messages: [
        { role: 'system', content: WALKTHROUGH_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      response_format: zodResponseFormat(WalkthroughOutput, 'walkthrough'),
      max_completion_tokens: MAX_WALKTHROUGH_TOKENS,
    });
    return completion.choices[0]?.message?.parsed?.items ?? [];
  } catch {
    return [];
  }
}

import { describe, expect, it } from 'vitest';
import { isBotMentioned } from '@/webhook/handler';

describe('isBotMentioned', () => {
  it('matches a bare mention', () => {
    expect(isBotMentioned('please @pr-cascade-bot review again', 'pr-cascade-bot')).toBe(true);
  });

  it('matches with bot suffix', () => {
    expect(isBotMentioned('hey @pr-cascade-bot[bot] thoughts?', 'pr-cascade-bot')).toBe(true);
  });

  it('matches case insensitively', () => {
    expect(isBotMentioned('@Pr-Cascade-Bot', 'pr-cascade-bot')).toBe(true);
  });

  it('does not match a different name as substring', () => {
    expect(isBotMentioned('@pr-cascade-bot-extra please', 'pr-cascade-bot')).toBe(false);
  });

  it('does not match without the leading at sign', () => {
    expect(isBotMentioned('pr-cascade-bot please review', 'pr-cascade-bot')).toBe(false);
  });

  it('does not match an unrelated mention', () => {
    expect(isBotMentioned('@some-other-bot please review', 'pr-cascade-bot')).toBe(false);
  });
});

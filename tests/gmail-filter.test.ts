/**
 * Tests for the Gmail email filter engine.
 *
 * Covers: all filter rule types, importance scoring,
 * rule combinations, edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateFilter,
  computeImportance,
  buildFilterRules,
  isAutomatedEmail,
} from '../src/channels/gmail/filter.js';
import type { EmailFilterRules } from '../src/channels/gmail/filter.js';
import type { ParsedEmail } from '../src/channels/gmail/gmail-client.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function mockEmail(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    from: 'alice@example.com',
    to: 'user@gmail.com',
    subject: 'Hello World',
    snippet: 'This is a test email',
    date: Date.now(),
    labelIds: ['INBOX'],
    isStarred: false,
    isImportant: false,
    headers: {},
    attachments: [],
    ...overrides,
  };
}

function defaultRules(overrides: Partial<EmailFilterRules> = {}): EmailFilterRules {
  return buildFilterRules(overrides);
}

// ─── isAutomatedEmail ─────────────────────────────────────────────────────

describe('isAutomatedEmail', () => {
  // ── RFC Headers ──

  it('detects Auto-Submitted: auto-replied', () => {
    const result = isAutomatedEmail(mockEmail({ headers: { 'auto-submitted': 'auto-replied' } }));
    expect(result).toContain('Auto-Submitted');
  });

  it('detects Auto-Submitted: auto-generated', () => {
    const result = isAutomatedEmail(mockEmail({ headers: { 'auto-submitted': 'auto-generated' } }));
    expect(result).toContain('Auto-Submitted');
  });

  it('allows Auto-Submitted: no (human-sent)', () => {
    const result = isAutomatedEmail(mockEmail({ headers: { 'auto-submitted': 'no' } }));
    expect(result).toBeNull();
  });

  it('detects Precedence: bulk', () => {
    const result = isAutomatedEmail(mockEmail({ headers: { precedence: 'bulk' } }));
    expect(result).toContain('Precedence');
  });

  it('detects Precedence: list', () => {
    const result = isAutomatedEmail(mockEmail({ headers: { precedence: 'list' } }));
    expect(result).toContain('Precedence');
  });

  it('detects Precedence: junk', () => {
    const result = isAutomatedEmail(mockEmail({ headers: { precedence: 'junk' } }));
    expect(result).toContain('Precedence');
  });

  it('detects X-Auto-Response-Suppress header', () => {
    const result = isAutomatedEmail(mockEmail({ headers: { 'x-auto-response-suppress': 'OOF' } }));
    expect(result).toContain('X-Auto-Response-Suppress');
  });

  it('detects List-Unsubscribe header (mailing list)', () => {
    const result = isAutomatedEmail(
      mockEmail({ headers: { 'list-unsubscribe': '<mailto:unsub@list.com>' } }),
    );
    expect(result).toContain('List-Unsubscribe');
  });

  // ── Sender Patterns ──

  it('detects noreply@ sender', () => {
    const result = isAutomatedEmail(mockEmail({ from: 'noreply@github.com' }));
    expect(result).toContain('noreply@');
  });

  it('detects no-reply@ sender', () => {
    const result = isAutomatedEmail(mockEmail({ from: 'no-reply@accounts.google.com' }));
    expect(result).toContain('no-reply@');
  });

  it('detects mailer-daemon@ sender', () => {
    const result = isAutomatedEmail(mockEmail({ from: 'MAILER-DAEMON@mail.gmail.com' }));
    expect(result).toContain('mailer-daemon@');
  });

  it('detects notifications@ sender', () => {
    const result = isAutomatedEmail(mockEmail({ from: 'notifications@github.com' }));
    expect(result).toContain('notifications@');
  });

  it('detects bounce@ sender', () => {
    const result = isAutomatedEmail(mockEmail({ from: 'bounce@service.com' }));
    expect(result).toContain('bounce@');
  });

  // ── Normal Emails ──

  it('allows normal human email', () => {
    const result = isAutomatedEmail(mockEmail({ from: 'alice@example.com' }));
    expect(result).toBeNull();
  });

  it('allows email with no special headers', () => {
    const result = isAutomatedEmail(mockEmail());
    expect(result).toBeNull();
  });
});

// ─── evaluateFilter ────────────────────────────────────────────────────────

describe('evaluateFilter', () => {
  it('passes an email with default rules', () => {
    const result = evaluateFilter(mockEmail(), defaultRules());
    expect(result.passed).toBe(true);
    expect(result.importance).toBeGreaterThan(0);
  });

  // ── Exclude Senders ──

  it('excludes by sender regex pattern', () => {
    // Use a human-like sender that only matches the user-configured regex
    const result = evaluateFilter(
      mockEmail({ from: 'spam@marketing.com' }),
      defaultRules({ excludeSenders: ['spam@marketing'] }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Sender excluded');
  });

  it('exclude patterns are case-insensitive', () => {
    const result = evaluateFilter(
      mockEmail({ from: 'Spam@Marketing.COM' }),
      defaultRules({ excludeSenders: ['spam@marketing'] }),
    );
    expect(result.passed).toBe(false);
  });

  it('skips invalid regex patterns gracefully', () => {
    const result = evaluateFilter(
      mockEmail({ from: 'alice@example.com' }),
      defaultRules({ excludeSenders: ['[invalid-regex'] }),
    );
    expect(result.passed).toBe(true);
  });

  // ── Required Labels ──

  it('rejects email missing required labels', () => {
    const result = evaluateFilter(
      mockEmail({ labelIds: ['SENT'] }),
      defaultRules({ labels: ['INBOX'] }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Missing required label');
  });

  it('passes if email has at least one required label', () => {
    const result = evaluateFilter(
      mockEmail({ labelIds: ['INBOX', 'STARRED'] }),
      defaultRules({ labels: ['STARRED', 'IMPORTANT'] }),
    );
    expect(result.passed).toBe(true);
  });

  // ── Starred Only ──

  it('rejects non-starred email when starredOnly is true', () => {
    const result = evaluateFilter(
      mockEmail({ isStarred: false }),
      defaultRules({ starredOnly: true }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Not starred');
  });

  it('passes starred email when starredOnly is true', () => {
    const result = evaluateFilter(
      mockEmail({ isStarred: true }),
      defaultRules({ starredOnly: true }),
    );
    expect(result.passed).toBe(true);
  });

  // ── Important Contacts ──

  it('rejects sender not in important contacts list', () => {
    const result = evaluateFilter(
      mockEmail({ from: 'stranger@unknown.com' }),
      defaultRules({ importantContacts: ['boss@company.com', 'team@company.com'] }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('not in important contacts');
  });

  it('passes sender in important contacts (substring match)', () => {
    const result = evaluateFilter(
      mockEmail({ from: 'Boss <boss@company.com>' }),
      defaultRules({ importantContacts: ['boss@company.com'] }),
    );
    expect(result.passed).toBe(true);
  });

  it('supports glob patterns in important contacts', () => {
    const result = evaluateFilter(
      mockEmail({ from: 'anyone@company.com' }),
      defaultRules({ importantContacts: ['*@company.com'] }),
    );
    expect(result.passed).toBe(true);
  });

  it('glob patterns are case-insensitive', () => {
    const result = evaluateFilter(
      mockEmail({ from: 'CEO@Company.COM' }),
      defaultRules({ importantContacts: ['*@company.com'] }),
    );
    expect(result.passed).toBe(true);
  });

  it('empty importantContacts allows all senders', () => {
    const result = evaluateFilter(
      mockEmail({ from: 'anyone@anywhere.com' }),
      defaultRules({ importantContacts: [] }),
    );
    expect(result.passed).toBe(true);
  });

  // ── Min Importance ──

  it('rejects email below minImportance threshold', () => {
    const result = evaluateFilter(
      mockEmail({ labelIds: ['SENT'], isStarred: false, isImportant: false }),
      defaultRules({ labels: [], minImportance: 0.9 }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('below threshold');
  });

  it('passes high-importance email above threshold', () => {
    const result = evaluateFilter(
      mockEmail({
        labelIds: ['INBOX', 'STARRED', 'IMPORTANT'],
        isStarred: true,
        isImportant: true,
      }),
      defaultRules({ minImportance: 0.5 }),
    );
    expect(result.passed).toBe(true);
  });

  // ── Rule Ordering ──

  it('exclude sender fires before label check', () => {
    // Even though email has INBOX label, sender is excluded
    const result = evaluateFilter(
      mockEmail({ from: 'spam@evil.com', labelIds: ['INBOX'] }),
      defaultRules({ excludeSenders: ['spam@evil'], labels: ['INBOX'] }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Sender excluded');
  });

  it('label check fires before starred check', () => {
    const result = evaluateFilter(
      mockEmail({ labelIds: ['SENT'], isStarred: false }),
      defaultRules({ labels: ['INBOX'], starredOnly: true }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Missing required label');
  });

  // ── Automated Sender Detection (Stage 0) ──

  it('rejects automated email before user rules are checked', () => {
    // Even with permissive rules, automated emails are rejected
    const result = evaluateFilter(
      mockEmail({ from: 'noreply@service.com', labelIds: ['INBOX'] }),
      defaultRules(),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Automated email');
  });

  it('rejects mailing list email via List-Unsubscribe header', () => {
    const result = evaluateFilter(
      mockEmail({
        from: 'newsletter@company.com',
        headers: { 'list-unsubscribe': '<mailto:unsub@company.com>' },
      }),
      defaultRules(),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Automated email');
  });

  it('rejects bulk precedence email', () => {
    const result = evaluateFilter(
      mockEmail({ from: 'promo@shop.com', headers: { precedence: 'bulk' } }),
      defaultRules(),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Automated email');
  });
});

// ─── computeImportance ─────────────────────────────────────────────────────

describe('computeImportance', () => {
  it('base importance is 0.2', () => {
    const score = computeImportance(
      mockEmail({ labelIds: [], isStarred: false, isImportant: false, subject: '' }),
    );
    expect(score).toBeCloseTo(0.2, 2);
  });

  it('starred adds 0.3', () => {
    const score = computeImportance(mockEmail({ labelIds: [], isStarred: true }));
    expect(score).toBeCloseTo(0.55, 2); // 0.2 + 0.3 + 0.05 (subject)
  });

  it('important adds 0.2', () => {
    const score = computeImportance(mockEmail({ labelIds: [], isImportant: true }));
    expect(score).toBeCloseTo(0.45, 2); // 0.2 + 0.2 + 0.05
  });

  it('CATEGORY_PERSONAL adds 0.15', () => {
    const score = computeImportance(mockEmail({ labelIds: ['CATEGORY_PERSONAL'] }));
    expect(score).toBeCloseTo(0.4, 2); // 0.2 + 0.15 + 0.05
  });

  it('INBOX without category adds 0.1', () => {
    const score = computeImportance(mockEmail({ labelIds: ['INBOX'] }));
    expect(score).toBeCloseTo(0.35, 2); // 0.2 + 0.1 + 0.05
  });

  it('INBOX with promotions does NOT add 0.1', () => {
    const score = computeImportance(mockEmail({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }));
    expect(score).toBeCloseTo(0.25, 2); // 0.2 + 0.05 (subject only)
  });

  it('caps at 1.0', () => {
    const score = computeImportance(
      mockEmail({
        labelIds: ['INBOX', 'CATEGORY_PERSONAL', 'STARRED', 'IMPORTANT'],
        isStarred: true,
        isImportant: true,
      }),
    );
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

// ─── buildFilterRules ───────────────────────────────────────────────────────

describe('buildFilterRules', () => {
  it('provides sensible defaults', () => {
    const rules = buildFilterRules({});
    expect(rules.starredOnly).toBe(false);
    expect(rules.importantContacts).toEqual([]);
    expect(rules.labels).toEqual(['INBOX']);
    expect(rules.excludeSenders).toEqual([]);
    expect(rules.minImportance).toBe(0);
  });

  it('overrides defaults with provided values', () => {
    const rules = buildFilterRules({
      starredOnly: true,
      importantContacts: ['boss@company.com'],
      labels: ['STARRED'],
      minImportance: 0.5,
    });
    expect(rules.starredOnly).toBe(true);
    expect(rules.importantContacts).toEqual(['boss@company.com']);
    expect(rules.labels).toEqual(['STARRED']);
    expect(rules.minImportance).toBe(0.5);
  });
});

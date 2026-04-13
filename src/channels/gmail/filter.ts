/**
 * Email filter engine.
 *
 * Evaluates incoming emails against a two-stage filter:
 *   Stage 1: Automated sender detection — drops machine-generated emails
 *            using RFC headers and common sender patterns. Always active.
 *   Stage 2: User-configured rules — starredOnly, importantContacts,
 *            excludeSenders, labels, minImportance.
 *
 * All functions are pure and stateless for easy testing.
 */

import type { ParsedEmail } from './gmail-client.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EmailFilterRules {
  /** Only process starred emails. */
  starredOnly: boolean;
  /** Only process emails from these senders (case-insensitive substring or glob). */
  importantContacts: string[];
  /** Only process emails with at least one of these Gmail labels. */
  labels: string[];
  /** Exclude emails matching these sender patterns (regex strings). */
  excludeSenders: string[];
  /** Minimum importance score (0.0–1.0). */
  minImportance: number;
}

export interface FilterResult {
  /** Whether the email passed all filters. */
  passed: boolean;
  /** Why the email was rejected (empty if passed). */
  reason?: string;
  /** Computed importance score (0.0–1.0). */
  importance: number;
}

// ─── Automated Sender Detection ───────────────────────────────────────────

/**
 * Sender address patterns that indicate machine-generated email.
 * Checked as case-insensitive prefix/substring against the From address.
 */
const AUTOMATED_SENDER_PATTERNS = [
  'noreply@',
  'no-reply@',
  'no_reply@',
  'donotreply@',
  'do-not-reply@',
  'mailer-daemon@',
  'postmaster@',
  'bounce@',
  'bounces@',
  'notifications@',
  'notification@',
  'auto-confirm@',
  'automailer@',
];

/**
 * Check if an email is machine-generated using RFC headers and sender patterns.
 *
 * RFC 3834 defines Auto-Submitted for auto-generated messages.
 * Precedence: bulk/list is a de-facto standard for mailing lists.
 * List-Unsubscribe (RFC 2369) indicates mailing list traffic.
 * X-Auto-Response-Suppress is a Microsoft extension for OOF/auto-replies.
 *
 * These emails are never actionable for a personal AI agent — a human
 * would never forward them to an assistant and say "handle this."
 */
export function isAutomatedEmail(email: ParsedEmail): string | null {
  const headers = email.headers;

  // RFC 3834: Auto-Submitted header (auto-replied, auto-generated, auto-notified)
  const autoSubmitted = headers['auto-submitted'] ?? '';
  if (autoSubmitted && autoSubmitted !== 'no') {
    return `Auto-Submitted: ${autoSubmitted}`;
  }

  // Precedence: bulk or list (de-facto standard for newsletters/mailing lists)
  const precedence = (headers['precedence'] ?? '').toLowerCase();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
    return `Precedence: ${precedence}`;
  }

  // X-Auto-Response-Suppress (Microsoft OOF/auto-replies)
  if (headers['x-auto-response-suppress']) {
    return 'X-Auto-Response-Suppress header present';
  }

  // List-Unsubscribe (RFC 2369 — mailing list traffic)
  if (headers['list-unsubscribe']) {
    return 'List-Unsubscribe header present (mailing list)';
  }

  // Common automated sender address patterns
  const from = email.from.toLowerCase();
  for (const pattern of AUTOMATED_SENDER_PATTERNS) {
    if (from.includes(pattern)) {
      return `Automated sender pattern: ${pattern}`;
    }
  }

  return null;
}

// ─── Filter ────────────────────────────────────────────────────────────────

/**
 * Evaluate an email against the configured filter rules.
 *
 * Rules are applied in order — first rejection wins:
 * 0. Automated sender detection (always active — RFC headers + sender patterns)
 * 1. Exclude sender patterns (deny list)
 * 2. Required labels
 * 3. Starred-only gate
 * 4. Important contacts (allow list — if non-empty, sender must match)
 * 5. Minimum importance threshold
 */
export function evaluateFilter(email: ParsedEmail, rules: EmailFilterRules): FilterResult {
  const importance = computeImportance(email);

  // 0. Automated sender detection (always active)
  const automatedReason = isAutomatedEmail(email);
  if (automatedReason) {
    return { passed: false, reason: `Automated email: ${automatedReason}`, importance };
  }

  // 1. Exclude sender patterns (deny list)
  if (rules.excludeSenders.length > 0) {
    const from = email.from.toLowerCase();
    for (const pattern of rules.excludeSenders) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(from)) {
          return { passed: false, reason: `Sender excluded by pattern: ${pattern}`, importance };
        }
      } catch {
        // Invalid regex — skip
      }
    }
  }

  // 2. Required labels
  if (rules.labels.length > 0) {
    const hasRequiredLabel = rules.labels.some((label) => email.labelIds.includes(label));
    if (!hasRequiredLabel) {
      return {
        passed: false,
        reason: `Missing required label (need one of: ${rules.labels.join(', ')})`,
        importance,
      };
    }
  }

  // 3. Starred-only gate
  if (rules.starredOnly && !email.isStarred) {
    return { passed: false, reason: 'Not starred (starredOnly is enabled)', importance };
  }

  // 4. Important contacts (allow list)
  if (rules.importantContacts.length > 0) {
    const from = email.from.toLowerCase();
    const matches = rules.importantContacts.some((contact) => {
      const pattern = contact.toLowerCase();
      // Support glob-style wildcards: *@domain.com
      if (pattern.includes('*')) {
        const regex = new RegExp(
          '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
        );
        return regex.test(from);
      }
      // Substring match
      return from.includes(pattern);
    });

    if (!matches) {
      return { passed: false, reason: 'Sender not in important contacts', importance };
    }
  }

  // 5. Minimum importance threshold
  if (importance < rules.minImportance) {
    return {
      passed: false,
      reason: `Importance ${importance.toFixed(2)} below threshold ${rules.minImportance.toFixed(2)}`,
      importance,
    };
  }

  return { passed: true, importance };
}

/**
 * Compute an importance score for an email (0.0–1.0).
 *
 * Heuristic based on Gmail labels and email properties:
 * - STARRED: +0.3
 * - IMPORTANT: +0.2
 * - CATEGORY_PERSONAL: +0.15
 * - INBOX (not promotions/social/updates): +0.1
 * - Has subject: +0.05
 * - Base: 0.2
 */
export function computeImportance(email: ParsedEmail): number {
  let score = 0.2; // Base importance

  if (email.isStarred) score += 0.3;
  if (email.isImportant) score += 0.2;
  if (email.labelIds.includes('CATEGORY_PERSONAL')) score += 0.15;
  if (
    email.labelIds.includes('INBOX') &&
    !email.labelIds.includes('CATEGORY_PROMOTIONS') &&
    !email.labelIds.includes('CATEGORY_SOCIAL') &&
    !email.labelIds.includes('CATEGORY_UPDATES')
  ) {
    score += 0.1;
  }
  if (email.subject.length > 0) score += 0.05;

  return Math.min(score, 1.0);
}

/**
 * Build a default set of filter rules from config values.
 * Fills in missing fields with sensible defaults.
 */
export function buildFilterRules(config: Partial<EmailFilterRules>): EmailFilterRules {
  return {
    starredOnly: config.starredOnly ?? false,
    importantContacts: config.importantContacts ?? [],
    labels: config.labels ?? ['INBOX'],
    excludeSenders: config.excludeSenders ?? [],
    minImportance: config.minImportance ?? 0,
  };
}

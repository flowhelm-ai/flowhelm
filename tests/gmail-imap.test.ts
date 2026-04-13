/**
 * Tests for the IMAP/SMTP client utilities.
 *
 * Covers: XOAUTH2 token building. Connection tests are skipped
 * (require a real IMAP server).
 */

import { describe, it, expect } from 'vitest';
import { buildXOAuth2Token } from '../src/channels/gmail/imap-client.js';

describe('buildXOAuth2Token', () => {
  it('produces valid base64-encoded XOAUTH2 SASL token', () => {
    const token = buildXOAuth2Token('user@gmail.com', 'access-token-123');

    // Decode and verify format
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    expect(decoded).toBe('user=user@gmail.com\x01auth=Bearer access-token-123\x01\x01');
  });

  it('handles special characters in email', () => {
    const token = buildXOAuth2Token('user+tag@gmail.com', 'token');
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    expect(decoded).toContain('user=user+tag@gmail.com');
  });

  it('handles long access tokens', () => {
    const longToken = 'ya29.' + 'x'.repeat(200);
    const result = buildXOAuth2Token('user@gmail.com', longToken);
    const decoded = Buffer.from(result, 'base64').toString('utf-8');
    expect(decoded).toContain(longToken);
  });
});

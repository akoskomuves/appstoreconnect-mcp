import { describe, expect, it } from 'vitest';
import { evaluateVersionLockGate } from '../src/domains/product-version-resolve.js';
import { ASCError, ascErrorText } from '../src/errors.js';

// The localization edit lock, confirmed live 2026-09-13:
//
//   409 ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE
//   "Cannot edit SubscriptionLocalization when it is in ACTIVE state"
//
// ACTIVE is in no public enum. Since 1.17 the pre-check reads the state of the
// localization's VERSION instead, which explains the lock directly: copy on an
// approved version is frozen, and the fix is a new version.

describe('evaluateVersionLockGate', () => {
  it('refuses copy on an approved version and points at a new version', () => {
    for (const st of ['APPROVED', 'REPLACED_WITH_NEW_VERSION']) {
      const g = evaluateVersionLockGate('subscription', st);
      expect(g.allow).toBe(false);
      expect(g.reason).toContain('new version');
      expect(g.reason).toContain('asc_post_subscription_version');
    }
  });

  it('refuses while the version is in review', () => {
    for (const st of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACCEPTED']) {
      expect(evaluateVersionLockGate('iap', st).allow).toBe(false);
    }
  });

  it('allows editable versions', () => {
    for (const st of [
      'PREPARE_FOR_SUBMISSION',
      'READY_FOR_REVIEW',
      'REJECTED',
      'DEVELOPER_REJECTED',
    ]) {
      expect(evaluateVersionLockGate('subscriptionGroup', st).allow).toBe(true);
    }
  });

  it('passes through when the state could not be read', () => {
    expect(evaluateVersionLockGate('subscription', undefined).allow).toBe(true);
  });
});

describe('ascErrorText', () => {
  // The regression this exists for: ASCError.message is only the envelope, so
  // a check that greps the message alone can never see Apple's `detail`.
  const err = new ASCError(
    409,
    'App Store Connect API 409 on PATCH /v1/subscriptionLocalizations/x',
    {
      errors: [
        {
          code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE',
          detail: 'Cannot edit SubscriptionLocalization when it is in ACTIVE state',
          source: { pointer: '/data/attributes/state' },
        },
      ],
    },
  );

  it("surfaces Apple's detail text, which never appears in .message", () => {
    expect(err.message).not.toContain('ACTIVE state');
    expect(ascErrorText(err)).toContain('Cannot edit SubscriptionLocalization');
    expect(ascErrorText(err)).toContain('UNMODIFIABLE');
  });

  it('keeps the envelope alongside the detail', () => {
    expect(ascErrorText(err)).toContain('409 on PATCH');
  });

  it('handles a string details body', () => {
    expect(ascErrorText(new ASCError(500, 'boom', 'upstream exploded'))).toContain(
      'upstream exploded',
    );
  });

  it('handles a plain Error and a non-Error', () => {
    expect(ascErrorText(new Error('nope'))).toBe('nope');
    expect(ascErrorText('just a string')).toBe('just a string');
  });

  it('does not throw on an ASCError with no details', () => {
    expect(() => ascErrorText(new ASCError(404, 'not found'))).not.toThrow();
  });
});

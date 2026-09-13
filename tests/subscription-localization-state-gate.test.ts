import { describe, expect, it } from 'vitest';
import { evaluateSubscriptionLocalizationGate } from '../src/domains/subscription-localizations.js';
import { ASCError, ascErrorText } from '../src/errors.js';

// Apple's gate on SubscriptionLocalization PATCH, confirmed live 2026-09-13:
//
//   409 ENTITY_ERROR.ATTRIBUTE.INVALID.UNMODIFIABLE
//   "Cannot edit SubscriptionLocalization when it is in ACTIVE state"
//
// ACTIVE appears in NEITHER public enum (SubscriptionLocalizationState is
// PREPARE_FOR_SUBMISSION / WAITING_FOR_REVIEW / APPROVED / REJECTED;
// Subscription.state has no ACTIVE at all), and the list endpoint reported the
// affected locales as APPROVED right before the refusal. So the gate is
// deliberately conservative: it refuses only on the combination actually
// observed — APPROVED copy under a locked parent — and passes everything else
// through to Apple.

describe('evaluateSubscriptionLocalizationGate', () => {
  it('refuses APPROVED copy under a live (APPROVED) subscription — the confirmed case', () => {
    const g = evaluateSubscriptionLocalizationGate('APPROVED', 'APPROVED');
    expect(g.allow).toBe(false);
    expect(g.reason).toContain('APPROVED');
    expect(g.next).toContain('web UI');
  });

  it.each([
    'WAITING_FOR_REVIEW',
    'IN_REVIEW',
    'PENDING_BINARY_APPROVAL',
  ])('refuses APPROVED copy while the parent is in %s', (parentState) => {
    expect(evaluateSubscriptionLocalizationGate(parentState, 'APPROVED').allow).toBe(false);
  });

  it.each([
    'MISSING_METADATA',
    'READY_TO_SUBMIT',
    'DEVELOPER_ACTION_NEEDED',
    'REJECTED',
    'DEVELOPER_REMOVED_FROM_SALE',
    'REMOVED_FROM_SALE',
  ])('allows APPROVED copy when the parent is in editable state %s', (parentState) => {
    expect(evaluateSubscriptionLocalizationGate(parentState, 'APPROVED').allow).toBe(true);
  });

  it.each([
    'PREPARE_FOR_SUBMISSION',
    'WAITING_FOR_REVIEW',
    'REJECTED',
  ])('allows %s copy even under a live subscription — never-shipped copy is still editable', (localizationState) => {
    expect(evaluateSubscriptionLocalizationGate('APPROVED', localizationState).allow).toBe(true);
  });

  it('passes through when the parent state could not be fetched', () => {
    expect(evaluateSubscriptionLocalizationGate(undefined, 'APPROVED').allow).toBe(true);
  });

  it('passes through when the localization state could not be fetched', () => {
    expect(evaluateSubscriptionLocalizationGate('APPROVED', undefined).allow).toBe(true);
  });

  it('passes through on a state Apple has not published yet', () => {
    expect(evaluateSubscriptionLocalizationGate('SOME_NEW_STATE', 'APPROVED').allow).toBe(true);
    // ACTIVE itself is the undocumented value Apple names in the error. If it
    // ever surfaces as a readable localization state, it is not APPROVED and
    // so falls through to Apple rather than being guessed at here.
    expect(evaluateSubscriptionLocalizationGate('APPROVED', 'ACTIVE').allow).toBe(true);
  });

  it('reports both states back for the refusal message', () => {
    const g = evaluateSubscriptionLocalizationGate('APPROVED', 'APPROVED');
    expect(g.parentState).toBe('APPROVED');
    expect(g.localizationState).toBe('APPROVED');
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

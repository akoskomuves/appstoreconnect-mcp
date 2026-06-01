import { describe, expect, it } from 'vitest';
import { evaluateStateGate } from '../src/domains/appstore-version-localizations.js';

// Apple's AppStoreVersion state machine gates which AppStoreVersionLocalization
// fields are mutable. evaluateStateGate is the pure (offline-testable)
// pre-check the patch tool runs before sending the PATCH.
//
// Behavior spec (from Apple's docs + observed live in v0.10):
//   - PREPARE_FOR_SUBMISSION + *_REJECTED + DEVELOPER_REMOVED_FROM_SALE
//     -> all six fields mutable
//   - READY_FOR_SALE + PENDING_DEVELOPER_RELEASE +
//     REPLACED_WITH_NEW_VERSION + REMOVED_FROM_SALE
//     -> ONLY promotionalText mutable (Apple's documented escape hatch)
//   - WAITING_FOR_REVIEW + IN_REVIEW + PROCESSING_FOR_APP_STORE
//     -> NOTHING mutable
//   - Unknown / undefined state -> pass through

describe('evaluateStateGate', () => {
  describe('promo-only states (READY_FOR_SALE et al)', () => {
    const promoOnlyStates = [
      'READY_FOR_SALE',
      'PENDING_DEVELOPER_RELEASE',
      'REPLACED_WITH_NEW_VERSION',
      'REMOVED_FROM_SALE',
    ];

    for (const state of promoOnlyStates) {
      it(`refuses non-promo fields when state is ${state}`, () => {
        const result = evaluateStateGate(state, {
          promotionalText: 'ok',
          marketingUrl: 'https://example.com',
        });
        expect(result.allow).toBe(false);
        expect(result.blocked).toContain('marketingUrl');
        expect(result.allowed).toEqual(['promotionalText']);
        expect(result.reason).toContain(state);
        expect(result.nextEditablePath).toContain('new App Store version');
      });

      it(`allows promotionalText-only when state is ${state}`, () => {
        const result = evaluateStateGate(state, { promotionalText: 'Just promo.' });
        expect(result.allow).toBe(true);
        expect(result.blocked).toEqual([]);
        expect(result.allowed).toEqual(['promotionalText']);
      });

      it(`refuses ALL non-promo fields when state is ${state} (whatsNew alone)`, () => {
        const result = evaluateStateGate(state, { whatsNew: 'new feature' });
        expect(result.allow).toBe(false);
        expect(result.blocked).toEqual(['whatsNew']);
        expect(result.allowed).toEqual(['promotionalText']);
      });

      it(`refuses all six non-promo fields when batched without promo, state ${state}`, () => {
        const result = evaluateStateGate(state, {
          whatsNew: 'a',
          description: 'b',
          keywords: 'c',
          marketingUrl: 'https://x.com',
          supportUrl: 'https://y.com',
        });
        expect(result.allow).toBe(false);
        expect(result.blocked.sort()).toEqual(
          ['whatsNew', 'description', 'keywords', 'marketingUrl', 'supportUrl'].sort(),
        );
      });
    }
  });

  describe('frozen states (WAITING_FOR_REVIEW, IN_REVIEW, PROCESSING_FOR_APP_STORE)', () => {
    const frozenStates = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PROCESSING_FOR_APP_STORE'];

    for (const state of frozenStates) {
      it(`refuses EVERYTHING (even promotionalText alone) when state is ${state}`, () => {
        const result = evaluateStateGate(state, { promotionalText: 'try me' });
        expect(result.allow).toBe(false);
        expect(result.allowed).toEqual([]);
        expect(result.blocked).toContain('promotionalText');
        expect(result.reason).toContain(state);
        expect(result.nextEditablePath).toContain('Wait for review');
      });

      it(`refuses multi-field batch when state is ${state}`, () => {
        const result = evaluateStateGate(state, {
          promotionalText: 'p',
          whatsNew: 'w',
        });
        expect(result.allow).toBe(false);
        expect(result.allowed).toEqual([]);
        expect(result.blocked.sort()).toEqual(['promotionalText', 'whatsNew'].sort());
      });
    }
  });

  describe('editable states (PREPARE_FOR_SUBMISSION et al)', () => {
    const editableStates = [
      'PREPARE_FOR_SUBMISSION',
      'DEVELOPER_REJECTED',
      'METADATA_REJECTED',
      'REJECTED',
      'INVALID_BINARY',
      'DEVELOPER_REMOVED_FROM_SALE',
    ];

    for (const state of editableStates) {
      it(`allows multi-field batch when state is ${state}`, () => {
        const result = evaluateStateGate(state, {
          whatsNew: 'new',
          description: 'longer desc',
          keywords: 'a,b,c',
          marketingUrl: 'https://x.com',
        });
        expect(result.allow).toBe(true);
        expect(result.blocked).toEqual([]);
        expect(result.allowed.sort()).toEqual(
          ['whatsNew', 'description', 'keywords', 'marketingUrl'].sort(),
        );
      });

      it(`allows single field when state is ${state}`, () => {
        const result = evaluateStateGate(state, { whatsNew: 'just notes' });
        expect(result.allow).toBe(true);
        expect(result.blocked).toEqual([]);
        expect(result.allowed).toEqual(['whatsNew']);
      });
    }
  });

  describe('unknown / undefined state — pass-through', () => {
    it('passes through when state is undefined (pre-check fetch failed)', () => {
      const result = evaluateStateGate(undefined, {
        promotionalText: 'p',
        marketingUrl: 'https://example.com',
      });
      expect(result.allow).toBe(true);
      expect(result.blocked).toEqual([]);
      // Apple's API stays the authoritative gate.
    });

    it('passes through when state is a brand-new Apple value we do not recognize', () => {
      // If Apple adds NEW_STATE_APPLE_INVENTED we want to not block;
      // Apple's server-side error remains the source of truth.
      const result = evaluateStateGate('NEW_STATE_APPLE_INVENTED', {
        whatsNew: 'whatever',
        marketingUrl: 'https://x.com',
      });
      expect(result.allow).toBe(true);
      expect(result.blocked).toEqual([]);
    });
  });

  describe('result shape', () => {
    it('includes state, allowed, blocked, reason, nextEditablePath in refusals', () => {
      const result = evaluateStateGate('READY_FOR_SALE', {
        promotionalText: 'p',
        marketingUrl: 'https://x.com',
      });
      expect(result).toMatchObject({
        allow: false,
        state: 'READY_FOR_SALE',
        allowed: ['promotionalText'],
        blocked: ['marketingUrl'],
      });
      expect(result.reason).toBeTruthy();
      expect(result.nextEditablePath).toBeTruthy();
    });

    it('does not include reason / nextEditablePath when allowing', () => {
      const result = evaluateStateGate('PREPARE_FOR_SUBMISSION', { whatsNew: 'ok' });
      expect(result.allow).toBe(true);
      // reason / nextEditablePath may be undefined in allow-true responses.
      expect(result.reason).toBeUndefined();
      expect(result.nextEditablePath).toBeUndefined();
    });
  });
});

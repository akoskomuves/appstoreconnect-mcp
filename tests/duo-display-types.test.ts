import { describe, expect, it } from 'vitest';
import { PreviewTypeSchema, ScreenshotDisplayTypeSchema } from '../src/schemas.js';

// iPhone Duo display types. Apple's published OpenAPI spec (4.5.1) and the
// ScreenshotDisplayType doc page don't list them, but the live API does:
// a create with an unknown screenshotDisplayType 409s with
// ENTITY_ERROR.ATTRIBUTE.TYPE, and its `detail` lists APP_IPHONE_DUO and
// IMESSAGE_APP_IPHONE_DUO (checked 2026-10-23). The same probe on
// appPreviewSets lists IPHONE_DUO. There is no separate inner/outer value.
// Pinned so a future regen from Apple's spec doesn't silently drop them.

describe('iPhone Duo display types', () => {
  it('ScreenshotDisplayType accepts APP_IPHONE_DUO and IMESSAGE_APP_IPHONE_DUO', () => {
    expect(ScreenshotDisplayTypeSchema.parse('APP_IPHONE_DUO')).toBe('APP_IPHONE_DUO');
    expect(ScreenshotDisplayTypeSchema.parse('IMESSAGE_APP_IPHONE_DUO')).toBe(
      'IMESSAGE_APP_IPHONE_DUO',
    );
  });

  it('PreviewType accepts IPHONE_DUO (no APP_ prefix, no iMessage variant)', () => {
    expect(PreviewTypeSchema.parse('IPHONE_DUO')).toBe('IPHONE_DUO');
    expect(PreviewTypeSchema.safeParse('APP_IPHONE_DUO').success).toBe(false);
    expect(PreviewTypeSchema.safeParse('IMESSAGE_IPHONE_DUO').success).toBe(false);
  });

  it('does not invent inner/outer variants Apple does not accept', () => {
    for (const v of ['APP_IPHONE_DUO_INNER', 'APP_IPHONE_DUO_OUTER']) {
      expect(ScreenshotDisplayTypeSchema.safeParse(v).success).toBe(false);
    }
  });
});

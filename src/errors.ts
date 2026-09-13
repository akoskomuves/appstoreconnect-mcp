export class ASCError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ASCError';
  }
}

/**
 * Flatten an ASC error into one searchable string.
 *
 * `ASCError.message` is only the envelope — "App Store Connect API 409 on
 * PATCH /v1/subscriptionLocalizations/{id}". Apple's actual `code`, `title`
 * and `detail` live in `details`, so any check that greps the message alone
 * silently never matches. Always match against this instead.
 */
export function ascErrorText(err: unknown): string {
  if (!(err instanceof ASCError)) {
    return err instanceof Error ? err.message : String(err);
  }
  const details = typeof err.details === 'string' ? err.details : JSON.stringify(err.details ?? '');
  return `${err.message} ${details}`;
}

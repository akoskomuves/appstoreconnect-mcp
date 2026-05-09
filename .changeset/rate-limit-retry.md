---
'appstoreconnect-mcp': patch
---

Handle Apple's 429 rate limits transparently in the HTTP client.

`client.request` now retries on 429 up to 6 times, honouring the `Retry-After` header when present and falling back to exponential backoff (2s → 4s → 8s … capped at 60s). Without this, applying many subscription prices in parallel would cause Apple to start rejecting writes after ~50 requests/minute and the per-row catch in `ppp_apply_proposal` was reporting them as failed without retry — leaving partial pending schedules. Discovered when a 60-territory apply only landed 10 of the writes before Apple started throwing 429s.

Also lowered the default `maxConcurrency` for `ppp_apply_proposal` from 5 to 2. With the new retry behaviour the higher concurrency mostly produced backoff stalls; 2 keeps writes well under Apple's threshold without sacrificing meaningful wall time on a typical 60-row run.

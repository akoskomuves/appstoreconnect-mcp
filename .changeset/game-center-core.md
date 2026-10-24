---
"@akoskomuves/appstoreconnect-mcp": minor
---

Game Center core (API 4.5.1, non-deprecated v2 paths): 81 new tools for Game Center details, groups, achievements, leaderboards and leaderboard sets — items, versions, localizations, images (composite upload + raw reserve/commit), ordering, set membership and member localizations, score moderation, blocked players, and server-side score / achievement submissions. Deletes are pre-checked against version state with a `force` escape. Live-smoke corrections (2026-10-24): an app without Game Center answers 200 + data:null; live achievements can have 0 points; `assetDeliveryState` is a struct; the leaderboard-set fieldset must list `gameCenterLeaderboards`; `blockedPlayers` and `gameCenterScoreModerations` answer 404 PATH_ERROR (in the spec, not switched on yet).

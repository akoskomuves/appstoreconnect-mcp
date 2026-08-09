---
'@akoskomuves/appstoreconnect-mcp': patch
---

Fix PAY_UP_FRONT intro/promo offer creates 409ing: `numberOfPeriods` was only sent for PAY_AS_YOU_GO, but Apple requires it for PAY_UP_FRONT too (`ENTITY_ERROR.ATTRIBUTE.REQUIRED`). The intro-offer, promo-offer, and PPP apply payload builders now send `numberOfPeriods` whenever provided and default it to 1 for PAY_UP_FRONT; the PPP intro-offer apply path now delegates to the shared `buildIntroOfferBody` instead of a hand-rolled twin. Tool descriptions, schema hints, and README updated to match.

---
'@akoskomuves/appstoreconnect-mcp': minor
---

Provisioning & code signing (19 tools) — the Developer-portal surface, completing the expansion roadmap's v1.3 phase:

- **Bundle IDs**: list (identifier filter) / get (with capabilities + profiles) / register / rename / delete. The reverse-DNS identifier is immutable post-create.
- **Capabilities**: enable / update settings (raw CapabilitySetting passthrough) / disable — with the profiles-must-regenerate warning.
- **Certificates**: list (type filter) / get (base64 DER `certificateContent`) / create from a PEM CSR (private key never goes to Apple) / revoke (⚠️ DELETE = REVOKE).
- **Profiles**: list (type filter) / get (base64 `.mobileprovision` in `profileContent`) / create (bundle ID + certs + devices for dev/ad-hoc types) / delete. Profiles are immutable — rotate by delete + re-create.
- **Devices**: list / register (⚠️ effectively permanent — devices can only be disabled, never deleted) / rename + enable/disable.

All tools explain the role gate on 403: this surface needs an Admin (or Account Holder) API key; App Manager / Developer keys work everywhere else in the server but not here. passTypeIds / merchantIds (Wallet / Apple Pay identity types) deliberately left out.

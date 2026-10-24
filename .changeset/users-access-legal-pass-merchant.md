---
"@akoskomuves/appstoreconnect-mcp": minor
---

Add Users & Access, legal agreements, and Pass Type / Merchant IDs (38 tools).

- **Users & Access**: users, visible apps, invitations and actors. Reads are free. Every write that changes the team (change roles or app access, remove a user, invite, cancel an invitation) refuses and sends nothing unless the call passes `confirm: true`; the refusal names the person and spells out the exact change (roles lost and gained, apps lost, Account Holder and ADMIN warnings).
- **Legal agreements**: the app's custom EULA (create, read, update text and territories, delete back to Apple's standard EULA) and the TestFlight beta license agreement (read and update text). An app with no custom EULA is reported as "standard EULA", not as an error.
- **Pass Type IDs and Merchant IDs**: list, get, list certificates, register, rename and delete, with the same Admin-key 403 hint as the provisioning tools.

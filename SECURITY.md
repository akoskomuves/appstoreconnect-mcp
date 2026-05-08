# Security policy

## Reporting a vulnerability

Please report security issues privately rather than via a public GitHub issue:

- Preferred: [GitHub Security Advisories](https://github.com/akoskomuves/appstoreconnect-mcp/security/advisories/new)
- Email: komuvesakos@icloud.com

You should expect an acknowledgement within a few days. Please include:

- A description of the issue and its impact.
- Steps to reproduce.
- Any relevant version / environment information.

## What's in scope

- Vulnerabilities in this MCP server's code (command injection, prototype pollution, JWT signing flaws, credential leakage, etc.).
- Documentation that recommends an unsafe practice.

## What's out of scope

- Bugs in the upstream `@modelcontextprotocol/sdk`, `jose`, `zod`, or other dependencies — please report those to their maintainers.
- Bugs in the Apple App Store Connect API itself.

## Handling `.p8` keys

This server reads an App Store Connect `.p8` private key from a path on disk. The key never leaves your machine — it's used locally to sign short-lived ES256 JWTs (≤20 min TTL) that authenticate requests to Apple.

Recommended hygiene:

- Store the `.p8` outside any git working tree (e.g., `~/.appstore/AuthKey_XXXXXXXXXX.p8`).
- Never commit the key, the issuer ID, or the key ID.
- Use the **least-privileged role** that gets your work done — Admin for pricing writes, App Manager for read-only.
- Rotate the key periodically via the App Store Connect → Users and Access → Integrations page.

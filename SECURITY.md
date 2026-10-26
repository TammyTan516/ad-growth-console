# Security policy

## Scope

Ad Growth Console is a static workflow demonstration. It has no authentication server, backend authorization, real advertising integration, or shared task queue. Browser identity switches and task locks are simulation controls that a user can change locally.

The project must not be treated as a production console for real accounts or customer data without adding and reviewing those services.

## Data handling

- Use synthetic campaign, asset, audience, and reporting data.
- File selectors record names and metadata; the demo does not read audience rows or upload files.
- Local demo state is stored in `localStorage`. It is not encrypted storage and is accessible to scripts running on the same origin.
- Do not enter API keys, access tokens, cookies, authorization codes, passwords, email lists, or customer identifiers.
- Do not commit browser-state exports, real datasets, internal links, screenshots containing private data, or environment files with secrets.
- External example links are placeholders; opening a link is separate from the simulated workflow.

For local-only access, the preview server can be restricted to the loopback interface:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

## Reporting a vulnerability

If private vulnerability reporting is available on the repository's **Security** tab, use it. Otherwise, open a minimal issue asking for a private reporting channel, without including exploit details or sensitive material.

Include the affected version or commit, expected behavior, observed behavior, and a reproduction using synthetic data. Do not post credentials, personal information, internal URLs, private source documents, or a full browser-storage dump in public issues or pull requests.

If credentials have already been exposed, revoke or rotate them through their provider. Editing a public issue or commit does not guarantee that prior copies have disappeared.

## Before connecting real services

Production integrations require server-side identity and account authorization, protected credentials, reviewed data handling, durable task ownership and idempotency, provider-result reconciliation, and auditable execution records. Demo fingerprints and asset identifiers are workflow markers, not cryptographic security guarantees.

# Security policy

## Current scope

The team development application has real email/password authentication, server-side team and role checks, and a persistent local SQLite store. Better Auth handles passwords and authentication sessions. Business APIs separately check active membership and authorization on each request.

The independent `/demo` page remains a local simulation. Its identity selector, approvals, task locks, audience matching, platform identifiers, and reports do not represent production authorization or advertising operations. Demo state is not imported into the shared team database.

The application has not been deployed or approved as a production console. It implements resource/UTM management, restricted personal Codex generation, human review and a desktop browser-task protocol; no real ad creation or enablement has been verified. Actual advertising operations require the task owner's permitted desktop Computer Use session and signed-in browser, live account/form checks, private evidence and a scoped submission checkpoint. There is no automatic browser launch, unattended platform worker or dispatch into an existing chat. Enterprise SSO, recovery email, provider account synchronization and scheduled reporting remain future work. Model-account access, each platform/ad type and cloud storage require separate live verification.

## Protected data

- Keep initialization secrets, invitation links, passwords, cookies, session records, and database files private.
- Initialization is a one-time administrator setup step. Possession of its token grants the ability to create the initial administrator before setup completes.
- Invitations are email-specific and one-time. Share complete links only with the intended recipient through a trusted channel; this version does not verify mailbox ownership or send the link automatically.
- Runtime secrets and records belong in the private data directory or a deployment secret manager. Do not commit `.env`, `.local/`, backups, logs, or browser-storage exports.
- Use synthetic campaign and audience fixtures in tests and public issue reports. Keep company URLs, production tracking conventions, customer information, and real audience rows out of the source tree.
- Real uploaded media, creator advertising codes, source URLs, audience hashes, and business UTM settings are private team data. The media endpoint requires active team membership; file URLs are not public share links. Team viewers can read authorized team media, while edits require an editor or administrator.
- Audience CSV import retains only aggregate counts and SHA256 hashes of trimmed/lowercased emails. The original CSV and plaintext rows are not persisted. Hashing does not make customer identifiers anonymous, establish consent, or prove platform eligibility; protect hashes and backups as sensitive data. Provider matching/normalization may require reimport of the original source.
- Public sitemap retrieval is bounded and rejects internal/reserved addresses, DNS rebinding, cross-origin redirects/maps, and XML entity expansion. It reads URLs only. Treat imported names, URLs, notes, and generated content as untrusted data; do not embed them as executable HTML or instructions.
- Generation requests contain resource metadata and business notes, not creator codes, audience hashes, or image/video pixels. When a member queues a job, the confirmed local connector submits that prompt through the member's installed Codex CLI and configured account. Treat notes and generated content as private data, and review the content being sent. Manual copy/import remains available. The application server does not read, copy, or receive Codex login credentials.
- A pairing code lasts five minutes and is one-time; it must not appear in a URL, persistent browser storage, logs or screenshots. A named device remains pending until the owner explicitly confirms it in the website. The scoped app token is separate from Codex authentication: the server keeps only its hash, while the local connector keeps the plaintext token in its private state directory. Revoke the device in the website if its token or computer is compromised.
- Pairing establishes workspace/device ownership, not proof of a matching Codex email. The local CLI may be signed into another account. Separate computers or OS accounts are needed when colleagues require distinct local Codex identities; a shared OS login can share Codex authentication.
- The runner uses a bounded, ephemeral, read-only generation process, ignores personal/project configuration and requires the CLI options needed to disable tool access. Missing required capabilities fail rather than enabling unrestricted execution. Managed Codex policy may further restrict or reject a run. These controls are not a comprehensive OS isolation or CLI security audit.
- Jobs bind owner, connector, proposal revision and generation request. Claims and leases are server-owned; result validation and import are transactional. Cancelled/revoked/stale/expired work must not overwrite a newer proposal or grant review approval. A private local outbox retains uncertain results and retries only their delivery. Its contents are sensitive and must not enter Git, public logs or issue reports.
- Optional OSS credentials exist only in server-side secret configuration. Keep the bucket private and scope its identity to the configured object prefix and required read/upload/private-ACL permissions. The adapter does not issue public or presigned media links, create buckets, or migrate the database. Incomplete OSS configuration blocks new uploads; it does not silently switch to local storage. Existing local files remain private and require continued retention.
- Administrators and editors may review their own proposals. If organizational policy requires independent approval, add that restriction before relying on this workflow. An approved proposal can authorize a scoped paused-build task only after complete account/settings validation. It never authorizes enablement; a fresh, exact-object human confirmation is required.
- Browser tasks bind the reviewed revision, owner, confirmed device, exact assets, account scope and per-level object IDs. Leases, short-lived submission nonces and single-use enablement previews are application controls, not independent evidence that a platform was operated correctly. Screenshots/observations come from the executor; never fabricate them or treat synthetic test evidence as live verification.
- Browser cookies, saved passwords and Codex login files stay outside this application. The bridge reuses only its scoped private app credential. It does not grant desktop/browser permissions. Keep local browser-job leases, cached materials and checkpoint JSON private; never pass secrets through command arguments or chats.
- Execution screenshots may contain business or personal data. Capture only relevant platform screens, keep them behind team authentication, and avoid credentials or unrelated personal information. Team viewers may inspect authorized execution evidence; write/claim/enable actions still require their separate server checks.
- Confirm non-delivery before publication. If a current wizard cannot guarantee pause at that point, record a blocked/draft result. Never publish active and attempt to pause afterward. Separate enablement is bound to the same created IDs and reviewed budget scope; recheck current account/objects before executing.
- After a timeout or lease loss during submit, reconcile actual platform objects before repeating any action. Preserve successful objects and do not retry enablement as creation. Existing parent campaigns must retain their state and budget when only a new group was authorized.
- First browser scope is one material/group/ad per platform, with format/identity limits documented in [platform boundaries](docs/PLATFORM-BROWSER.md). Creator-code-only publishing is blocked; saving an advertising code does not prove authorization. Existing audience IDs must be mapped explicitly; hashed CSV import does not establish provider eligibility or matching.
- The demo records file names and metadata only; it does not read audience rows or upload files. Its `localStorage` is accessible to scripts running on the same origin and is not an encrypted vault.
- Review Git author/committer metadata as well as file contents before publishing. Removing an address from a source file does not remove it from a commit's metadata.

The activity log records application changes and their authenticated actors. A person with direct database write access can still alter that store; this is not a tamper-proof external audit ledger.

## Deployment

Use one service instance with persistent writable storage for the SQLite backend and retained local media versions. Back up the database and its referenced local files together, and retain/backup referenced OSS objects when OSS is used. Database snapshots alone do not include material files. Cloud object storage does not make SQLite stateless or multi-instance. Do not rely on an ephemeral serverless filesystem or independently replicated local files. Keep the origin behind a reviewed HTTPS endpoint, supply strong independent secrets, configure the expected origin, and test backups and recovery.

Default loopback-only development access is intentional. Making the service reachable from other machines requires an appropriate accessible origin and deployment review. Do not weaken origin checks or authentication to make a preview work. A read-only member must remain unable to write even if browser controls are modified.

Disabling a team member revokes business-workspace access for its existing session; it does not necessarily delete that user's authentication account. Protect the last active administrator and maintain an operational recovery plan outside the public application.

## Reporting a vulnerability

Use private vulnerability reporting on the repository's **Security** tab when available. Otherwise, open a minimal issue asking for a private reporting channel without exploit details or sensitive material.

Include the affected version or commit, expected behavior, observed behavior, and a reproduction using synthetic data. Never post passwords, keys, cookies, invitation or pairing codes, connector or lease tokens, private outboxes, initialization links, personal information, internal URLs, or full database/browser-state dumps in public issues or pull requests.

If a credential or invitation has already been exposed, revoke or rotate it through the appropriate administration flow. Editing a public issue or commit does not guarantee that prior copies have disappeared.

## Before connecting real services

Production use requires account-scoped authorization, reviewed browser/data permissions, protected credentials, durable task ownership and idempotency, provider-result reconciliation, and audited execution boundaries. Validate actual before-publish pause controls and separate enablement with a concrete reviewed task; do not infer live support from protocol tests or a generation connector being online. Demo fingerprints and synthetic asset identifiers are workflow markers, not cryptographic security guarantees. Test and review each provider integration before trusting it with real operational data.

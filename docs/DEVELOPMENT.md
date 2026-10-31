# Development and deployment

## Current milestone

Phases 1–7 provide team access/history, private resources, UTM records, personal Codex generation with automatic return, human review, and a desktop browser execution protocol for paused creation and separately confirmed enablement. Each live account and browser workflow needs deployment-specific acceptance; synthetic tests do not establish production access. A private Alibaba Cloud OSS adapter is available, with real bucket configuration deferred; no bucket or cloud database is provisioned automatically. The original advertising demo remains independent. Phase 7 adds Google Ads account/campaign reports, prior-day comparisons, rule-based summaries and advisory suggestions. Daily reads run only while the server is online. Configuration and a successful live data read are distinct states. See [reporting setup](REPORTING.md). Meta/TikTok reporting and a registry for targeting existing campaigns remain later milestones.

The shared workspace requires the Node service. Running `python3 -m http.server` or publishing `dist/` serves only the original demo.

## Local setup

1. Install Node.js 24.15 or newer in the 24.x line and pnpm 11.25.0.
2. Run `pnpm install --frozen-lockfile` in the repository directory.
3. Run `pnpm start`.
4. Open `http://127.0.0.1:3000`.
5. Privately read `.local/bootstrap-token` from this machine and enter it into the first-run initialization form.
6. Choose the team name and administrator credentials. The initialization endpoint is no longer available after setup completes.
7. Sign in and invite another account from team settings.
8. Install/sign in to a compatible Codex CLI on each member's own computer, then pair and confirm that computer through **My Codex**. See [the connector guide](CODEX-CONNECTOR.md).

For an existing workspace, restart against the same `DATA_DIR`. Do not initialize another team or replace the database to upgrade the code.

Set passwords yourself. Do not commit or publish initialization tokens, invitation links, credentials, cookies, or a populated database. Do not create a second administrator by editing a browser identity selector; that selector exists only in the independent demo.

An invitation is limited to its target email and assigned role. New users register through an invitation; existing users sign in and accept it. The app does not automatically email the link, verify mailbox ownership, or provide an account-recovery email flow. Deliver links through a trusted private channel. Password recovery and enterprise identity-provider integration require separate implementation before a wider rollout.

## Configuration

| Name | Local development | Deployment requirement |
| --- | --- | --- |
| `NODE_ENV` | `development` | Use `production` after configuring the deployment |
| `APP_URL` | `http://127.0.0.1:3000` | One stable externally reachable HTTPS origin matching the browser URL, without a trailing slash, path, query, or fragment |
| `HOST` | `127.0.0.1` | Choose the bind interface appropriate for a protected reverse proxy |
| `PORT` | `3000` | Match the service and proxy configuration |
| `DATA_DIR` | `.local` | Private persistent writable directory or mounted volume |
| `BETTER_AUTH_SECRET` | Local development may create a private secret | Independently generated strong secret supplied through secret management |
| `BOOTSTRAP_TOKEN` | Local development may create `.local/bootstrap-token` | Independently generated one-time setup token, kept private until initialization |
| `MEDIA_STORAGE` | `local` | Select `oss` only after private bucket configuration is ready |
| `OSS_BUCKET`, `OSS_REGION`, `OSS_ENDPOINT`, `OSS_PREFIX` | Unset unless testing a configured private bucket | Scope uploads to the intended bucket, region and object prefix; see [OSS setup](OSS.md) |
| `OSS_ACCESS_KEY_ID`, `OSS_ACCESS_KEY_SECRET`, `OSS_STS_TOKEN` | Do not put real values in source or browser forms | Server-side scoped credentials; an STS token is optional and must be renewed operationally |

Use `.env.example` as a list of names, not as a working production secret file. The application does not automatically load `.env`:

```sh
node --env-file=.env server/index.mjs
```

The `APP_URL` origin, browser address, and proxy behavior must agree. Do not add wildcard origins to work around an authentication failure. When a different computer must access the service, configure the real accessible origin and transport rather than sending a colleague a `localhost` URL.

## Storage and sharing

The database belongs to the server. Different signed-in clients share team records through the API, not through browser storage. Keep the data directory out of public static routes and version control. `.local/`, environment files, SQLite files, backups, and logs are excluded from public packaging.

For this milestone, run one service instance against one persistent data directory. Multiple independent SQLite files produce independent workspaces. Ephemeral serverless filesystems lose changes when replaced. When horizontal scaling is required, migrate application and authentication records to a supported shared database before adding more service instances.

Back up the database using a SQLite-aware backup mechanism or a controlled stopped-service copy, together with referenced local uploaded-media versions and required deployment secrets. When OSS is configured, retain/backup its referenced objects as well; selecting OSS does not move SQLite data or old local media. Include any journal/WAL state required for a consistent backup. A database-only backup cannot restore the media files referenced by saved material versions. Test restoration in a separate private directory before relying on the backup. Do not publish backup files as GitHub artifacts.

## Resource and planning workflow

Materials can record supplier/creator source links and be uploaded manually, with a maximum file size of 100 MiB. Supported signatures are PNG, JPEG, GIF, WebP, MP4, and WebM; files are served only to signed-in members of the same team, with streaming and video byte ranges. The default local provider uses `DATA_DIR/uploads/materials/`. Optional OSS storage streams private objects through the authenticated server route, with size/hash validation and content-addressed keys; it does not expose public media URLs. Historical files without a storage-provider field continue to read from the local directory. Explicitly selecting OSS with incomplete configuration blocks new uploads instead of falling back to local storage. See [OSS setup](OSS.md); real bucket credentials and a live acceptance pass are still required. Selecting a stored material again reuses it; replacing a file creates another version. Downloading protected supplier/creator links automatically is not implemented. Creator advertising codes remain private and have not been validated against a provider.

Audience import accepts CSV up to 5 MiB and 50,000 data rows, with a named email column for multi-column files. The member confirms authority to use the list. The application stores format/count summaries and SHA256 hashes of trimmed/lowercased emails, not the source CSV or plaintext addresses. A valid-row count is not a platform-matched audience count. Keep the original source securely if a later provider adapter needs different normalization or another import. Database pulls are not connected.

Landing-page setup supports manual activity pages and a public HTTPS sitemap. Use **inspect** to load an index, choose the relevant child maps, then **update**. A root index without a choice returns `SITEMAP_SELECTION_REQUIRED`; it will not automatically crawl every content/discovery map. Selected child URLs must be declared by the inspected root. Current retrieval bounds are 2 MiB per document, 8 MiB total, 2,000 page URLs, 20 sitemap files, three nested index levels, a 25-second overall deadline, and three redirects per request. Requests use public-address validation, pinned DNS/TLS connections, and same-origin redirects/maps. Compressed maps, DTDs, and external entities are unsupported. A large site's content maps may need a smaller published child map.

Only page URLs are imported. Path-based names, empty descriptions, and unclassified tags are not evidence that a page was read. Members should add descriptions, tags, language, and conversion goal before relying on page matching. Refresh preserves those classifications and manual pages. Missing sitemap entries become unavailable; a changed child-map selection intentionally changes the imported scope. Errors leave the prior library/settings unchanged.

After saving the brief and resource selection, choose a confirmed online computer in the strategy/copy step and start automatic generation. The application creates an owner/device-bound job, the member's local connector invokes Codex, and a current valid result is saved back as editable content. The application server does not invoke a shared Codex login. Copy/download/JSON import remains available under the manual fallback. Media pixels are not included in automatic generation; only saved names, notes and page metadata are used. The request explains that unobserved product claims or video scenes must not be invented. Google currently means search-ad copy/keywords; final review checks headline/description counts and character width against the search format documented by [Google](https://developers.google.com/google-ads/api/docs/responsive-search-ads/create-responsive-search-ads). The platform adapter will still need its own creation-time validation. The structured import validates platform coverage and request freshness, then keeps the result editable for human review.

A team administrator must explicitly save the active UTM rule. The app does not import or certify a company's existing rule automatically. Supported template variables are `{proposalId}`, `{platform}`, `{materialId}`, `{materialRevision}`, `{landingId}`, `{landingRevision}`, `{trackingId}`, `{groupName}`, and `{title}`. A unique immutable registry UUID is always added as `tracking_code`; this supports a future business-backend join but that connection is not implemented. Existing nontracking query parameters and URL fragments are preserved. Repeated generation for identical inputs reuses the saved records.

Review checks the complete saved brief, current usable resource versions, content, and tracking links. The landing page must have a language and content summary, with language and conversion goal compatible with the brief; an unclassified sitemap URL alone is insufficient. An administrator or editor can submit, approve, return with required comments, or reopen; self-review is allowed. Brief/content/resource/UTM changes invalidate the effective current review while historical approved snapshots stay inspectable. A review is permission to queue that saved proposal for the scoped browser workflow; it is not a completed advertising operation or permission to enable ads. Saving account/settings creates a new revision and resets review.

## Connect each member's Codex

The member first creates a five-minute, one-time pairing code in **My Codex**. On their own computer, in the project directory, run:

```sh
node runner/connect.mjs --server "http://127.0.0.1:3000"
```

Replace the sample origin with the shared HTTPS workspace address for an internal deployment. A colleague's `localhost` means that colleague's computer, not the application host. When prompted by the connector, enter the code without putting it in command arguments. Return to the website, verify the device name, and complete the explicit device confirmation. Keep the connector running while using that computer for generation. No app/Codex credential is pasted into a website form.

The server keeps only a hash of its scoped connector credential. The plaintext app credential and pending-result outbox live in the member's private local connector directory. These are separate from Codex authentication; the connector does not open or copy the Codex auth file. Pairing does not establish a verified match between the Codex account email and the workspace member. The run uses whichever account the local CLI is signed into; separate computers/OS accounts are needed for separate local Codex identities.

The runner requires a modern CLI with the documented restricted-generation flags. It ignores user/project configuration and rules, uses an empty temporary workspace and a read-only sandbox, disables execution/tool integrations, and uses the CLI's default model/provider behavior with saved authentication. No model is hardcoded. Missing capabilities fail rather than falling back to unrestricted execution. Managed CLI requirements may impose additional restrictions or prevent a run. See [the connector guide](CODEX-CONNECTOR.md) for supported flags, diagnostics and overrides for locating the native executable.

A device is online for 45 seconds after its last heartbeat. A claimed job has a 60-second lease, renewed during generation; one connector processes one job at a time. The result must match the current proposal revision, generation request and selected usable resource versions. Automatic return resets the proposal to manual review; it cannot approve or publish an ad.

The connector saves its result to a private outbox before posting it. On an uncertain network delivery it resubmits the same result and lease, not another model run. The server accepts an identical already-committed result idempotently. Lease expiry, cancellation, revocation, changed versions, and rejected output require attention or an explicit new task. They are not automatically retried as generation. Raw local stdout/stderr, prompts and credentials are not posted as task error messages.

## Desktop browser execution

The content-generation CLI intentionally disables tools. Its online/ready state does not establish browser permission. Browser work uses a separate desktop Codex session with actual Computer Use access and the member's signed-in profile. Neither this server nor the bridge launches a browser or automatically dispatches to an existing Codex chat. A colleague manually copies the task's instructions into their own desktop chat and claims it with their existing active, confirmed app connection:

```sh
node runner/browser-client.mjs claim --build BUILD_ID
node runner/browser-client.mjs heartbeat --build BUILD_ID
```

Do not place tokens in arguments or chat. The generation worker need not be online for this desktop claim; the saved connection must remain active and belong to the task owner. Read [the browser guide](BROWSER-EXECUTION.md) for private material retrieval/cache, evidence, leases and recovery. Cached exact-version material is reused rather than downloaded for every run. The bridge does not automatically download supplier documents.

1. Save a one-material proposal and exact per-platform account, currency/time zone, budget layer/amount, locations/languages, placements, conversion goal, identity and any pre-existing platform audience bindings. For a new group, record its exact parent ID. Save settings before the final human review; settings changes reset it.
2. After approval, queue a paused-build task and review the frozen instructions/effective names. The UI labels it as waiting for desktop Codex; queueing does not operate a browser.
3. In the desktop session, inspect the actual browser inventory, select the intended profile, claim the task and verify account/form/parent scope. Capture real preflight and pre-submit screenshots. Obtain the task's one-time publish nonce only after the visible controls guarantee non-delivery before publishing. Stop with a blocked result if this cannot be established.
4. Publish once while paused, reopen the resulting objects and record real campaign/group/ad IDs plus actual switch states and screenshots. A draft, future start time or a successful local command is not verified paused creation. Unknown submission results must be reconciled against the same account/task before any retry; preserve successful platforms.
5. Read a fresh enablement preview in the website. The owner explicitly confirms exact object IDs, accounts and budgets, creating a separate task. Desktop execution rechecks the same objects, requests its separate submission nonce, enables only the allowed scope and reads it back. Never rebuild objects to recover an enablement failure. Enabled status does not establish delivery.

First scope: one selected material, one group and one ad per platform. Google Search uses reviewed headline/description combinations. Meta website-sales file ads and TikTok manual-auction website-conversion video file ads use the first reviewed headline and primary text; TikTok requires a linked identity. Creator-code-only publishing is blocked. Current screens, account eligibility, conversion settings and the publish-paused control require a platform-specific live check every time. See [platform boundaries](PLATFORM-BROWSER.md). Email CSV import is not provider matching; selected audiences require existing, correctly mapped platform audience IDs.

Live acceptance records belong to private runtime storage and are excluded from source releases. Each target deployment and advertising account needs its own verification. Tests below use synthetic IDs and evidence; they establish application control flow only. OSS setup remains deferred until private bucket details and a separate live upload/read check are available.

## Business acceptance

Use synthetic accounts and content in a separate temporary database:

1. Initialize an administrator, invite an editor/viewer, and verify shared data and roles.
2. Upload a synthetic image and confirm it persists after restart, is inaccessible without login or across teams, and has an immutable old revision after replacement.
3. Import a synthetic CSV with duplicate/invalid addresses. Confirm counts and absence of raw addresses in saved database files or API/catalog responses.
4. Import synthetic sitemap data. Edit classifications, refresh with a removed entry, and confirm classifications/manual pages/old versions remain while the removed entry becomes unavailable. A failed fetch or failed audit transaction must leave the previous library intact.
5. Create a one-platform proposal, select exact resource versions, and optionally include/exclude an audience. Check page recommendation reasons and the selected destination.
6. Pair two synthetic members with separate fake connectors. Confirm one-time pairing/owner confirmation, owner-only device access and cancellation, atomic claims, lease expiry, revocation, and rejection of cross-owner/cross-team results. Queue generation and return a structured synthetic result; verify automatic save, revision/history/audit, and no automatic approval. Reject stale/wrong-platform/forged results and duplicate different payloads. Test the manual fallback and edit protection as well.
7. Save the UTM rule as an administrator, generate links, repeat and verify stable IDs, then change inputs and verify new records coexist with old links. Check preserved query/fragment values and the unique `tracking_code`.
8. Submit, request changes, revise, and approve. Confirm authenticated reviewer/time and exact historical snapshot. Changing a resource or UTM rule must invalidate current approval without rewriting history.
9. Save simultaneous edits from two members. Confirm `409` preserves unsaved input and does not add a second version/audit entry. Force an audit failure and confirm all related writes roll back.
10. Disable a member, protect the last administrator, and reject revoked/used invitations, cross-origin requests, forged workflow state, and private static paths. Verify the disabled member's connector cannot claim or return work.
11. Restart an isolated connector with a pending outbox after an uncertain submission. Confirm it retries the exact result without running Codex again and that the server commits it at most once.
12. Test OSS with an injected fake client: private ACL/metadata, full/range reads, team-key isolation, safe provider errors, missing configuration without local fallback, and continued access to old local files. Do not claim a real bucket connection from these fixtures.
13. Queue a synthetic reviewed paused-build task and verify owner/device/team isolation, exact frozen resources/copy/accounts, settings-review invalidation and no spend permission from proposal approval.
14. Use explicitly fake screenshots/observations to test preflight and publish nonce gates, paused-result ID hierarchy, private evidence access, duplicate-result handling, cancellation and lease expiry. These fixtures do not attest to a real browser or paused platform object.
15. Simulate a lost submit response and partial success. Verify unknown outcomes block duplicate creation; reconciliation preserves found objects, and only confirmed missing objects allow an explicit retry.
16. Verify enablement needs a fresh one-time human preview, keeps exactly the existing IDs, rejects stale revisions/changed objects and cannot be retried as creation. A failed enablement needs a new review/confirmation, not an automatic spending retry.

Tests must not reuse a real business database or the user's production session. Synthetic assertions are not evidence of actual Codex-account inference, real OSS connectivity, successful advertising, provider matching, or model quality. Label any separate live Codex or OSS acceptance result with its actual environment and outcome. Browser acceptance is still required for the actual UI flow.

## Commands

```sh
pnpm test
pnpm run check
pnpm run build
```

`test` covers the legacy demo, team/resources/planning/connectors HTTP integration, restricted connector subprocess/outbox recovery, synthetic browser-task ownership/checkpoints/reconciliation/enablement, and local/injected OSS storage. `check` checks the public source tree for unexpected files and common sensitive material; it is not a complete secret scanner or authorization audit. `build` selects the static-demo files for `dist/` only. There is no frontend bundling step required for `workspace/`; the Node server serves those public assets.

After installing dependencies, the equivalent direct runtime commands are:

```sh
node server/index.mjs
node tests/workflow.test.cjs
node --test tests/*.test.mjs tests/storage.test.cjs
python3 scripts/check_release.py
python3 scripts/build.py
```

The proposal list displays the latest 500 records; overview counts include the team's complete proposal set. The activity screen displays the latest 500 matching events; the tracking registry returns the latest 1,000 records. All saved versions, tracking records, and audit entries remain in the database.

## Before an internal deployment

Prepare the following without adding private values to the repository:

- An application host with persistent storage and a stable HTTPS address.
- The intended invitation and member-management process, including who may administer the team.
- Independent authentication and initialization secrets, with an operational owner.
- Reverse-proxy origin and forwarding rules, request limits, backup/restore procedures, and monitoring of failures.
- A reviewed approach to account recovery and organization SSO if needed.
- A browser acceptance pass from two different computers, including concurrent edits, personal connector pairing, and session/connector revocation.
- A supported Codex CLI and intended local account on each generation computer, private local state, and an owner for running/restarting it.
- Desktop Codex Computer Use access and a selected signed-in profile on each browser execution computer, with an independently reviewed live acceptance pass for each supported platform/ad type and its before-publish pause control.
- If OSS is selected, a private bucket, scoped server credentials, object retention, and a labelled live upload/read acceptance pass.

This milestone does not include provisioning a cloud account, buying a domain, sending invitation email, configuring enterprise SSO, or deploying a production service. A working local service is not an assertion that those steps have been completed.

## Future milestones

Next milestones extend live platform coverage only after each browser workflow and reporting source is verified independently. Protected supplier downloads, provider audience normalization/matching, a synchronized campaign registry, supported automatic desktop-session binding and Meta/TikTok scheduled reporting remain future work. The content-generation connection does not grant browser access or spend authority. Daily reporting requires real data access and a defined always-available execution environment.

## Local live generation acceptance

On 2026-10-27, an isolated synthetic workspace completed one real generation through the installed Codex CLI `0.164.0-alpha.11.1`. A browser submitted a saved single-platform Google proposal, the owner-confirmed local connector claimed it, and actual CLI output was automatically imported as an editable new proposal version. The browser confirmed that human review remained pending and that refreshed records persisted. No advertising object was created or enabled. This verifies that local account and runtime for that request; it does not establish access for another member, every model, a remote deployment, or an OSS bucket.

The first live attempt exposed a nonfatal CLI diagnostic item being incorrectly classified as a tool call. The connector now permits diagnostic error items while still rejecting actual tool activity, top-level errors, unsuccessful turns, nonzero exit codes and invalid JSON. A regression covers this behavior.

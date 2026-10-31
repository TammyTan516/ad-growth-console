# Architecture

## Two independent entry points

| Entry | Runtime and storage | Current purpose |
| --- | --- | --- |
| `/` through the Node server | `workspace/` UI, authenticated HTTP API, shared SQLite database | Team access, versioned resources and proposals, private UTM records, personal Codex jobs with automatic content return, human review, owner-bound desktop browser tasks, separate enablement, conflicts, and activity records |
| `/demo` through the Node server, or root `index.html` through a static server | Original `src/` UI and browser `localStorage` | Synthetic end-to-end advertising workflow demonstration |

The team application does not import a demo snapshot, interpret a demo identity as a real member, or execute a demo advertising task. The static build remains a demo artifact. A static host alone cannot run the shared team application.

## Team development runtime

Node.js 24 serves the workspace and API. Better Auth manages email/password authentication and sessions. SQLite stores authentication records and application data on the server's persistent filesystem. The application checks the signed-in user, active team membership, and role for each business request.

The first administrator is created through a one-time initialization token. Subsequent accounts enter through email-specific invitations. The complete invitation secret is returned once at creation, while the database stores its hash. Invitations can be cancelled and cannot be reused after acceptance. This release does not send invitation or account-recovery email and does not claim that an email address has passed mailbox verification.

Roles are administrator, editor, and viewer. Administrators and editors can create and edit proposals; only administrators manage members and invitations. Viewers can read authorized team content. Disabling membership removes team access even when an authentication session remains valid. The last active administrator is protected from removal or demotion.

## Application records

| Record | Responsibility |
| --- | --- |
| Team | Shared workspace boundary |
| Member | User-to-team relationship, role, and enabled status |
| Invitation | Intended email, assigned role, expiry, one-time secret hash, and acceptance/cancellation state |
| Proposal | Stable identifier, current revision, title, draft/archive status, structured brief, and planning/review workflow |
| Proposal version | Immutable saved brief, resource snapshots, content, tracking references, and review state associated with a revision and actor |
| Resource and resource version | Material, audience, or landing-page metadata with immutable revisions; private file references and audience hashes remain server-side |
| Sitemap configuration | Last successful root address, chosen child maps, and synchronization time |
| Tracking configuration | Team-private versioned source/medium mappings and naming templates |
| Tracking record | Immutable link, registry identifier, exact proposal/resource/configuration references, and creation actor/time |
| Codex pairing and connector | Short-lived owner-bound pairing, explicit device confirmation, scoped token hash, local diagnostics, and revocation |
| Generation job | Owner/device/proposal/request binding, single claim, renewable lease, result identity, outcome, and saved result revision |
| Browser build task | Assigned owner/connector, immutable reviewed snapshot, platform states, renewable lease, known remote objects and recovery state |
| Browser evidence and submission checkpoint | Private screenshot references, visible account/pause observations and a short-lived single-submit nonce |
| Enablement preview | Expiring, single-use human confirmation bound to the exact paused object IDs, snapshot, account and budget |
| Activity entry | Who performed a supported change, when, and which proposal or membership it affected |

The structured brief retains the distinction between a new campaign and a new group under an existing campaign. It records selected platforms, goal, country, language, audience direction, budget, timing, group name, and an optional parent campaign reference. In this release, manually entered platform identifiers are unverified references, not a synchronized provider registry. They do not authorize execution or establish that an object exists on an advertising platform.

## Shared editing

Every saved proposal has a monotonically increasing revision. An update supplies the revision that the editor originally read. The server updates only if that revision is still current. A stale request returns HTTP `409` and the latest version; the UI keeps the unsaved editor input so the user can compare and explicitly resume editing.

The proposal update, immutable version, and related activity entry are saved as one transaction. The server chooses the actor from the authenticated session; client-supplied creator, reviewer, or role values do not become trusted attribution. This prevents an apparently successful save from silently erasing a colleague's work or losing the matching history entry.

The current history is an application audit trail. It is not an externally anchored, tamper-proof ledger against an administrator with direct database access.

## Resource libraries

Materials are registered as manual uploads, supplier content, or creator content. External source links are references; the server does not scrape authenticated documents or download remote assets from them. A member uploads the downloaded file once. The server validates a supported file signature, writes a content-addressed blob to the configured private local or OSS store, and creates a new material revision. Files are reused by later selections and revisions retain their prior references. A creator video may use a privately stored advertising code; catalogs, generation requests, and proposal snapshots expose its presence but not its value. Platform validity of that code has not been checked.

Audience CSV import supports historical payers, current subscribers, active users, campaign participants, and custom labels. An explicit confirmation of authority is required on import/replacement. The parser selects the email column, trims/lowercases addresses, deduplicates them, and persists SHA256 hashes and aggregate counts. Plaintext rows and the original CSV are not persisted. These hashes are still sensitive personal data; they are not a platform upload, a matched-audience count, or proof of eligibility. Provider-specific normalization, minimum-size checks, matching, and database pulls belong to later adapters and may require a fresh source import.

Landing pages may be added manually or synchronized from a public HTTPS sitemap. Indexes are inspected first so the member can choose relevant child maps instead of crawling an entire discovery/content inventory. Network retrieval rejects internal/reserved addresses, pins validated DNS answers to TLS connections, checks redirects, and applies document/count/depth/time limits. XML parsing does not expand DTD or external entities. The importer reads page URLs only. Names initially come from URL paths; descriptions, tags, language, and goals are maintained by members. It does not crawl the page body or establish its product claims.

A successful refresh preserves member-maintained classifications and manual activity pages. Sitemap pages absent from the newly chosen import scope become unavailable, rather than being deleted. Old versions remain inspectable. A failed import writes none of the candidate changes. Changing the selected child-map scope can therefore make previously imported sitemap pages unavailable; the selected scope is part of the saved synchronization settings.

## Planning, generation, and review

A proposal chooses exact material, optional include/exclude audience, and landing-page revisions. Saving captures safe immutable metadata. Library updates do not silently replace those choices; effective workflow warnings require the member to reselect current usable versions before review. Landing recommendations use transparent tag/language/goal matching, not a model or an unverified page-content analysis.

The generation button prepares a structured request from the saved brief and resource snapshot and queues it for the signed-in member's chosen, confirmed local connector. The application server does not launch a shared Codex account or read Codex credentials. The local connector invokes the official installed CLI with its saved local authentication, a restricted generation configuration, and an output schema. The returned JSON is validated and saved automatically as an editable proposal revision. Manual copy/download/import remains a fallback. Images/videos are not attached to this request: only file type, names, and notes are supplied. Google currently follows the search-ad workflow; Meta and TikTok do not receive search keywords. A prepared or queued request is not generated output.

Members can edit strategy and platform copy directly. Saved changes reset review. Human review validates a complete saved brief, current usable resource versions, strategy/copy, and final tracking links. Administrators and editors may submit, approve, request changes, or reopen, including their own proposals. This release does not enforce separate author/reviewer identities. Approved historical snapshots remain unchanged when later edits invalidate the current review. Review approval does not create or enable an advertisement. Saved execution account/settings also form part of the reviewed version; changing them resets approval.

## Personal Codex connections and jobs

Pairing starts in the authenticated website. A five-minute, single-use code is bound to the member and team. The connector exchanges it for a separate application-scoped credential, reports its local state, and remains pending until the same member explicitly confirms the named device in the website. The server stores a token hash; the plaintext connector token stays in the member's private local state directory. Normal team APIs do not accept that bearer credential. A connector can claim and return only jobs assigned to its owner and device. Other team members may see a proposal's job summary but cannot cancel or claim another member's job.

The Codex identity is whichever account the local CLI is signed into. Pairing does not cryptographically prove that its email equals the workspace member's email and does not switch the CLI's account. Colleagues should use their own computers or OS accounts when they need separate Codex identities. A shared OS account can share the same local Codex login. Personal/project Codex configuration is deliberately ignored for this generation process; no model is hardcoded, and the CLI's default model/provider behavior applies.

The connector runs one generation at a time. Server-side claims are atomic, and an active proposal job is unique. Device online state expires after 45 seconds; a claimed job has a 60-second lease renewed during generation. Expired leases require attention and an explicit new task rather than automatic generation retries. Disconnecting a device or disabling/downgrading its member prevents further use. The runner stops when it cannot confirm lease renewal or receives cancellation/revocation.

The result is written to a private local outbox before submission. Delivery retries reuse the exact job, lease and result; they do not rerun Codex. Server-side result hashes make an acknowledged result idempotent. A result must still match the current proposal revision, generation request and selected usable resource versions. The result import, proposal version, task completion and audit entries commit together. Stale, cancelled, failed or unacknowledged work cannot be shown as a successful current result. A completed import resets human review rather than approving or executing the proposal. Background UI updates retain unsaved edits and offer an explicit newer-version comparison when needed.

See [the connector guide](CODEX-CONNECTOR.md) for setup, supported CLI requirements, failure recovery and credential boundaries.

## Media storage provider

`MEDIA_STORAGE=local` is the default. Deployers can select private Alibaba Cloud OSS after supplying server-side bucket, region and scoped credentials. The provider adapter validates upload size/hash, streams with known content length and a private object ACL, and verifies remote size/hash metadata before a ready file reference is saved. Reads remain behind the application's team-authenticated route; OSS object URLs and credentials are not returned to the browser. Single byte-range reads support video playback.

A missing storage-provider field on a historical file means local storage. Those files remain readable after OSS is selected. Selecting an incompletely configured OSS provider blocks new uploads rather than silently storing them locally. Merely configuring the adapter does not establish cloud connectivity; a real upload/read acceptance pass is required. This feature does not create a bucket, migrate old media, or move SQLite data to a cloud database. See [OSS setup](OSS.md).

## Tracking registry

A team administrator explicitly saves the private UTM configuration. No existing enterprise document or spreadsheet is automatically treated as the active rule. Templates may use proposal, platform, material/version, landing/version, group, title, and tracking-record identifiers. The saved destination is chosen before generating UTM.

Generation creates one immutable tracking record per selected platform/material combination. It replaces existing `utm_*` and `tracking_code` query parameters, preserves other query parameters and the fragment, and adds the record's unique UUID as `tracking_code`. Identical inputs reuse the same records. Changed resource/configuration inputs create new records; old links remain in the registry. The configuration, link registry, and generation are internal to this app. Integration with a company's business backend or analytics collector remains future work.

## Desktop browser execution boundary

The team application implements a browser-task protocol separately from the restricted content-generation connector. It freezes reviewed account/settings, brief, exact resources, copy, landing page and UTM into a task assigned to one member and confirmed connector. The server does not launch a browser, use advertising APIs, automatically message an existing chat, or make the phase-5 CLI process browser-capable. A real desktop Codex session with permitted Computer Use must manually claim the task through `runner/browser-client.mjs` and operate that member's signed-in browser. See [browser execution](BROWSER-EXECUTION.md).

The lifecycle is queue → manual desktop claim → live account/form preflight → private screenshots → one short-lived submission nonce → publish while paused → reopen/read back real IDs and per-level switches. The current platform screen must establish that publication is non-delivering before a submit; otherwise the executor records a blocked/draft result. Publishing active and pausing afterward is not an accepted creation path. A nonce proves application authorization for one scoped submit, not independent provider attestation. Screenshots and observations are executor evidence and can be reviewed by team members.

The first scope uses one material, one group and one ad per selected platform. Google is Search only. Meta uses website-sales file creatives; TikTok uses manual-auction website-conversion video files with a linked advertising identity. Social ads use the first reviewed headline and primary text; Google uses the approved headline/description combination. Creator-code-only publishing is blocked. Each account/wizard must pass live checks; familiar platform labels do not establish unattended support. Existing audience IDs must match the selected resource revision and include/exclude purpose; CSV import does not upload or match an audience. [Platform boundaries](PLATFORM-BROWSER.md) specify checks and stop conditions.

Real campaign/group/ad IDs remain separate. A new-group task must verify its parent and preserve the parent's existing name, budget and on/off state. Task-tagged effective names assist reconciliation without replacing account/ID checks. Partial success preserves existing objects. A submit timeout or expired submission lease leaves an unknown result: query the same task's actual account, names and IDs before retrying. Only a confirmed missing result can return to explicit creation retry; enablement failures require a fresh human confirmation.

Enablement is a separate task after an expiring, one-time human preview of exact paused IDs, account, currency/time zone and budget. It binds the same reviewed snapshot and created IDs, then requires another browser preflight, submission checkpoint and readback. Proposal review, queued work and paused creation do not authorize spending. Observed enabled state does not prove platform approval or delivery.

Live platform access is verified per deployment and account, independently from synthetic automated tests. Phase 7 adds a fixed-query, read-only Google Ads reader, installation-team account binding, daily report snapshots/versions, data summaries and advisory suggestions. A running-server scheduler refreshes complete days with bounded conversion backfill. This module cannot change advertising execution state. Meta/TikTok reporting and a synchronized targeting campaign registry remain future work. Platform conversions and business registrations/first subscriptions remain separate measurements; source failures preserve the prior snapshot and remain visible. See [reporting boundaries](REPORTING.md).

## Deployment boundary

The SQLite store is supported as one application instance with one persistent data directory. Do not run independent copies against separate local files and expect shared state. A serverless temporary filesystem is not durable storage. Team deployment requires a persistent volume, backups, HTTPS, protected secrets, a reviewed reverse proxy, and an explicit recovery process. A shared Postgres store can be introduced when multi-instance deployment becomes necessary.

The application database and existing local material versions still require persistent application storage when new media uses OSS. Backups and retention must cover the SQLite database, referenced local files, and referenced OSS objects separately. No hosting vendor is required by the application. Company endpoints, credentials, real audience data, and production tracking rules belong in private deployment configuration, not in this public source tree.

## Verification

The original VM and storage tests validate demo invariants. Team/resource/planning integration tests exercise actual HTTP handlers, authentication, role and team boundaries, persistence, revisions, private media access/ranges, CSV privacy, deterministic sitemap sync, tracking idempotency, structured generation import, human review, transactional rollback, and restricted static serving using temporary synthetic data. Native network/parser helpers are tested for unsafe addresses and malformed XML without crawling real company sites. Browser checks remain necessary for UI behavior and layout. Connector tests additionally use synthetic subprocesses and private outboxes; browser tests use fake screenshots and platform observations to exercise the protocol, not real provider accounts; media-provider tests use local fixtures and an injected OSS client. These tests do not prove that a real member account completed a model run, that an actual OSS bucket is connected, that production is deployed, or that advertising is effective. Those results require separately labelled live acceptance evidence.

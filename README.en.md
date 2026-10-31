# Ad Growth Console

A review-first advertising and growth workspace, with a shared team-development application and a separate static workflow demo. The interface is primarily Chinese.

[简体中文](README.md)

The team application provides invitation-based accounts, server-checked roles, shared versioned proposals, resource libraries, private UTM rules, per-member Codex connections with automatic content return, human review, and owner-bound desktop browser tasks for paused creation and separately confirmed enablement. Records are saved in server-side SQLite; uploaded media uses the configured private local or Alibaba Cloud OSS storage. The original demo remains available at `/demo` with independent browser-local simulation state.

**Paused browser execution and a read-only Google Ads reporting integration are implemented.** The personal generation connector invokes the installed, signed-in Codex CLI and returns editable strategy/copy. Browser execution is a separate desktop Codex workflow: manually claim a reviewed task, use the member's signed-in browser, record actual screenshots, confirm pause before publishing, and reopen objects to verify their IDs and paused state. The bridge does not launch a browser or automatically send work to an existing chat. If the current wizard cannot guarantee pause before publishing, stop. Enablement requires a new human confirmation and another task for the same object IDs. Google daily reports require a separately configured, working Google OAuth connection; configuration alone is not a successful read. Each deployment, provider workflow and OSS connection needs its own live acceptance. Automated tests use synthetic data and do not prove production access.

The **Daily reports** page saves account/campaign metrics, preceding-day comparisons, conversion-action detail, rule-based summaries and advisory iteration suggestions. Daily refresh runs only while the server is online; it never enables paused ads. See [Google reporting setup and metric boundaries](docs/REPORTING.md).

## Run the team application

Requirements: Node.js 24.15 or newer in the 24.x line, pnpm 11.25.0, and a writable local data directory. Python 3 is used for the static-demo build, release checks and OAuth callback tests. The optional local Google authorization helper also needs `google-auth-oauthlib` in its private Python environment; the running Node reporting server does not use that dependency.

```sh
pnpm install --frozen-lockfile
pnpm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The default service is intended for local development. The first startup creates a one-time initialization token in `.local/bootstrap-token`. Read that local file privately and enter the token in the initialization form, then choose the team name, administrator email, display name, and password. Do not paste the token into an issue, chat transcript, or commit.

After initialization, log in with the administrator account. In team settings, create an invitation for a specific email and role. The complete invitation link is returned once for the administrator to share through a trusted channel; this version does not send email. A new colleague registers through that link. A colleague with an existing account signs in and accepts the invitation.

Only invited members may join. Sharing the homepage address alone does not grant workspace access.

## What to try

1. In the resource library, register supplier or creator sources and upload the downloaded image/video, or upload your own file. A creator video may instead record its advertising code. Source links alone do not download a file.
2. Optionally import an authorized audience CSV and label it as historical payers, current subscribers, active users, campaign participants, or a custom type. An audience may be included or excluded in a proposal.
3. Register an activity landing page or refresh a public sitemap. Classify pages with tags, descriptions, language, and conversion goal. Sitemap import reads page URLs, not page text or product claims.
4. Have an administrator save the team's actual UTM convention in tracking settings. Generic example values are editable suggestions until explicitly saved; no company's existing spreadsheet or internal convention is imported automatically.
5. Create a proposal for one or several platforms, or choose one platform and manually register the existing parent campaign for a new ad group. Parent references remain unverified.
6. Select the exact material, optional audience, and landing-page versions. Tag-based landing recommendations explain their matching reasons; confirm the destination yourself.
7. In **My Codex**, generate a short-lived pairing code, run `node runner/connect.mjs --server "http://127.0.0.1:3000"` from the project directory on your own computer, enter the code when prompted, and confirm the named device in the website. Use the actual shared HTTPS origin when deployed. In the proposal, choose your online device and start automatic generation. The returned JSON fills the editable strategy/copy; manual copy/import remains a fallback. Inputs currently include saved metadata, not image/video pixels. Google copy targets search ads. See the [connector guide](docs/CODEX-CONNECTOR.md).
8. Edit and save strategy, headlines, copy, and Google keywords. Generate final tracking links. In **Ad building**, save each selected platform's exact account, currency/time zone, budget, conversion event, placement, identity and optional existing audience mapping. This creates a new proposal version and resets review. Then submit the saved version for human review; an administrator or editor can approve or return it, including their own work.
9. Submit a paused-build task for a confirmed personal connection, inspect the frozen scope, and copy its desktop instructions into your own desktop Codex chat. Follow the [browser execution guide](docs/BROWSER-EXECUTION.md) to claim the task and use Computer Use. A queued task is waiting for manual desktop pickup. Inspect real object IDs/screenshots before requesting a fresh enablement preview; confirmation authorizes only the listed objects and possible budget spend. Unknown outcomes must be reconciled before any duplicate creation.
10. Inspect historical versions, the shared build library and activity log. A resource/brief/copy/UTM/account-setting change requires a new check and review; old snapshots, links and evidence remain available.
11. Open a proposal in two signed-in browsers. Save competing edits and confirm the outdated revision receives a conflict without overwriting the other person's work. A viewer cannot write, and a disabled member loses access even with an existing session.

| Role | View team resources, proposals, and history | Edit resources, proposals, and reviews | Manage members and UTM rules |
| --- | --- | --- | --- |
| Administrator | Yes | Yes | Yes |
| Editor | Yes | Yes | No |
| Viewer | Yes | No | No |

The last active administrator cannot be disabled or demoted through the team API. Roles and membership are checked on the server. Saving, approving, creating paused objects, and enabling those objects are separate steps. Only the task owner's assigned connection can claim browser work; team visibility does not grant permission to take over another member's task.

## Configuration and data

See [`.env.example`](.env.example) for supported names. Environment files are not loaded automatically; for an explicit local file:

```sh
node --env-file=.env server/index.mjs
```

Keep `.env` and `.local/` private. The server owns authentication records, membership, proposals, resource metadata and versions, private UTM settings, saved tracking links, review history, and activity records. Media storage defaults to the private data directory. Deployers can select private Alibaba Cloud OSS using server-side configuration; incomplete OSS configuration fails explicitly and never silently falls back to local uploads. Existing local files retain their original references. No real bucket or cloud database is provisioned automatically. See [OSS setup](docs/OSS.md). Selecting them again reuses the stored file; uploading a replacement creates another version. Audience imports retain counts and SHA256 hashes of trimmed/lowercased email addresses, not the original CSV or plaintext emails. Hashes remain sensitive personal data, and provider-specific matching/normalization is not implemented; a later platform integration may require reimporting the original CSV. Invitation secrets are stored as hashes. Do not place database copies, session cookies, tokens, personal audience data, or internal business configuration in the public repository.

SQLite is the current **single-instance** development store. A deployment needs a persistent writable volume, backups, a stable HTTPS `APP_URL`, and separately supplied strong secrets. Ephemeral serverless filesystems and multiple application instances with independent SQLite files are not supported. A shared Postgres deployment is a later migration option.

SSO, account-recovery email, automatic supplier/creator downloads, database audience pulls, Meta/TikTok reporting and a campaign registry for targeting existing plans are not integrated. Google reporting and online-server daily refresh are documented in [REPORTING.md](docs/REPORTING.md). Browser tasks use a manually operated desktop Codex session with Computer Use; there is no unattended browser worker or automatic chat dispatch. The first scope is one selected material, one group and one ad per platform: Google Search, Meta website-sales file ads, and TikTok manual-auction website-conversion video file ads using a linked identity. Meta/TikTok use the first reviewed headline and primary text; Google uses the reviewed headline/description combination. Creator-code-only publishing remains blocked. Each actual wizard must pass the visible pause gate; selecting a platform does not prove it is supported in that account. See [platform boundaries](docs/PLATFORM-BROWSER.md). OSS bucket configuration is deferred. The generation connector must be running for copy jobs; browser claims reuse its active confirmed identity but require a separate desktop browser session. A localhost address is usable only on the same computer. Set up and review those separately before using the application for real operational data. See [development and deployment notes](docs/DEVELOPMENT.md).

## Static demo

The original workflow prototype can be explored independently:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open [http://localhost:8080](http://localhost:8080). When using the team server, use `/demo` instead.

The demo shows resource selection, optional audiences, sample copy, landing pages, generic tracking links, review, task ownership, partial failure, unknown results, and sample reports. All identifiers, metrics, and operations there are examples. Its identity switches are not login controls, and its records stay in that browser's `localStorage`. Demo records are not imported into the team database.

## Build and verify

```sh
pnpm test
pnpm run check
pnpm run build
```

Tests cover the original simulation and the team application's actual HTTP, authorization, shared persistence, resource upload/privacy, sitemap parsing/sync, UTM records, generation jobs, review, rollback, and conflict behavior using synthetic fixtures. Connector subprocess/outbox tests, browser-task protocol tests and injected OSS tests use synthetic accounts, fake evidence and temporary data to check restricted generation, ownership, leases, frozen scopes, publish nonces, separate enablement, unknown-result reconciliation, result recovery, private storage references and ranges. Fake screenshots and platform IDs are test fixtures, not live advertising evidence. They do not validate production deployment, provider access, advertising performance, or a complete security review.

The build command creates **only the static demo** in `dist/`. It does not package or deploy the team backend. Run the Node service for the shared workspace. Build and release scripts select public source files and exclude runtime data.

## Documentation

- [Architecture and current boundaries](docs/ARCHITECTURE.md)
- [Development, setup, and deployment](docs/DEVELOPMENT.md)
- [Personal Codex connector](docs/CODEX-CONNECTOR.md)
- [Desktop browser execution and recovery](docs/BROWSER-EXECUTION.md)
- [Platform formats and pause checks](docs/PLATFORM-BROWSER.md)
- [Google Ads reporting and metric definitions](docs/REPORTING.md)
- [Private Alibaba Cloud OSS storage](docs/OSS.md)
- [Generic demo tracking rules](docs/TRACKING.md)
- [Security policy](SECURITY.md)

Contributions should use synthetic data and placeholder URLs. Review both file contents and Git author metadata before publishing. Keep company settings and data in private runtime configuration.

## License

[MIT](LICENSE). Advertising-platform names identify planned and demonstrated workflows; the project is not affiliated with those platforms.

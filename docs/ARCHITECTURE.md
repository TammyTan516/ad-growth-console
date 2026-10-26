# Architecture

## Runtime

The application is a static browser prototype with no third-party runtime dependencies. `index.html` is the entry page, `src/app.js` contains the workflow model, rendering, and event handlers, and `src/styles.css` supplies the interface styles. `scripts/build.py` copies an explicit list of public files into `dist/`. `src/host-adapter.js` supplies local snapshot persistence through `localStorage`.

The browser is the entire demo environment. There is no backend, real account connection, background scheduler, or automatic agent invocation. Different browser profiles and origins have independent state; switching a demo identity does not create a real user session.

## Information model

| Area | Responsibility |
| --- | --- |
| Overview | Pending work, exceptions, and recent campaign objects |
| Campaign management | Proposal drafts, reviewed versions, and account/campaign/group/ad hierarchy |
| Resources | Asset versions, optional audience versions, landing-page candidates, and tracking records |
| Execution | Task submission, ownership, preflight, results, and failed-item retry |
| Reports | Metrics tied to execution objects and follow-up test proposals |
| Team settings | Demonstration of roles, execution computers, and daily-work responsibility |

A proposal may target one or several platforms. Each platform has its own account, campaign, group, and ad references. A new group under an existing campaign reuses the parent campaign identifier and respects its fixed settings and budget layer. It does not silently create another parent campaign.

## Review and execution

The main journey is:

1. Describe the objective, platforms, audience direction, budget, and timing.
2. Select resources and their explicit versions.
3. Prepare the required assets on the execution computer.
4. Review sample copy, select landing pages, and confirm tracking links.
5. Approve the complete proposal version.
6. Submit and claim a build task, then run the preflight simulation.
7. Inspect per-platform results before requesting enablement.
8. Inspect delivery status, collect sample reports, and create the next test proposal.

Approval, object creation, platform review, enablement, and actual delivery are distinct states. Creating an ad does not imply that it is enabled or delivering. Meaningful content changes invalidate the current approval and preflight; historical execution snapshots retain the earlier inputs.

## Resources and fixed versions

Assets are registered separately from their use in a proposal. Selecting a resource version does not fetch it. The demo tracks file-cache availability per execution computer: existing versions can be reused, missing versions need preparation, and failed items remain incomplete. These are simulated cache records rather than checks of the real filesystem.

Creator-post references and uploaded-file workflows are distinct. An authorized post is associated with the relevant platform and identity; it does not imply permission to reuse the file elsewhere. An unavailable authorization or file remains a blocker.

Audiences are optional. Paid, usage, activity, and custom packages retain business criteria, source metadata, and version history. A newly registered package starts without platform matching. A bound proposal uses a snapshot, so editing the library does not replace the audience already selected for review. File selection records metadata only; no personal audience data is needed for the demo.

Landing-page updates demonstrate additions, changes, and failed reads. A library refresh does not replace a proposal's frozen selection. Explicitly choosing a newer page or resource version requires review again. [Tracking records](TRACKING.md) preserve the selected destination and corresponding proposal version.

## Ownership, retries, and unknown results

A build task is associated with an approved proposal version, an owner, and an execution computer. Another demo identity cannot take over an already owned task through the normal interface. This rule demonstrates the intended handoff; it is not a substitute for server-side enforcement.

Partial failure retains successful object references. Retrying targets the incomplete item instead of rebuilding every platform. An unknown submission result blocks conflicting changes and another submission until the original result is reconciled. A future integration needs durable idempotency and provider readback to implement these guarantees across processes.

## Reports and storage

Sample reports are tied to specific execution objects and versions. Missing sources remain unknown. Platform-attributed conversions and business registrations or first subscriptions have separate columns. A report suggestion creates a new draft rather than silently editing a delivering ad.

Snapshots persist locally. A failed or oversized save keeps the current in-memory state and displays a warning; a refresh can restore only the last successful snapshot. The demo is not a shared, durable audit database.

## Verification and extension

`tests/workflow.test.cjs` runs the state/event model in a Node.js VM with a minimal DOM and persistence stub. It covers workflow invariants such as review, task ownership, retry, unknown-result handling, resource-version protection, migration, and storage failure. `tests/storage.test.cjs` checks the local persistence adapter. These tests do not validate real platform APIs, browser layout, or production authorization.

Real integrations should preserve the model's review and version boundaries while replacing simulation steps with authorized operations and verified results. Shared accounts, files, and task ownership require a backend; scheduled work requires an actual executor. Production security and provider connectors remain separate implementation work.

# Ad Growth Console

A dependency-free, static prototype for planning advertising campaigns and reviewing an agent-assisted workflow across Google Ads, Meta, and TikTok.

[简体中文](README.zh-CN.md)

**This is a local simulation.** It does not connect advertising accounts, read audience lists, generate content with an AI service, upload assets, launch ads, or collect live reports. Identity switches and task ownership demonstrate workflow rules; they are not authentication or access controls.

## Run locally

From the repository directory:

```sh
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080). The interface is primarily Chinese.

The generated static page runs without third-party packages. Python 3 serves and builds the page; Node.js is needed only for the workflow tests and npm commands. No `npm install` is required.

## Explore the workflow

1. Create a proposal or choose an existing demo campaign as the parent of a new ad group.
2. Select asset versions and optionally choose an audience package.
3. Simulate checking files on the selected execution computer.
4. Review sample copy, choose landing pages, and save demo tracking links.
5. Approve the complete proposal version.
6. Submit and claim a build task; try complete, partial-failure, and unknown-result scenarios.
7. Review the separate enablement and delivery states, then simulate a reporting day and a new test group.

The six main areas are overview, campaign management, resources, execution, reports, and team settings. Resource libraries include assets, optional audiences, landing pages, and tracking records.

## What the prototype demonstrates

- Single-platform and multi-platform proposals, with separate account, campaign, group, and ad identifiers.
- Human review of a fixed version, with re-review after meaningful changes.
- Task ownership, per-computer asset-cache simulations, partial retries, and reconciliation before repeating an unknown submission.
- Frozen asset, audience, landing-page, and tracking references in historical execution records.
- Optional paid, usage, activity, and custom audiences; file selection records metadata only.
- Local sample reports that keep platform-attributed conversions separate from business registrations and first subscriptions.

All names, identifiers, URLs, metrics, and results are examples. Links under `example.com` are placeholders. Copy and page recommendations are deterministic examples, not AI output. File preparation and audience matching do not read file contents or contact a provider.

## State and limitations

State is stored in this browser's `localStorage`, scoped to its origin and profile. Other browsers and computers have independent state. Clearing site data removes the local demo history. If storage fails or reaches its limit, the interface shows a warning rather than claiming the new snapshot was saved.

Real account APIs, email lists, SSO, shared storage, cloud drives, scheduled jobs, and automatic Codex invocation are not integrated. A generated task description can be handed to a human or an agent; opening the page does not start another application. The demo can be explored in an ordinary browser without Codex.

## Build and test

```sh
npm run build
npm test
```

Equivalent commands:

```sh
python3 scripts/build.py
node tests/workflow.test.cjs
node --test tests/storage.test.cjs
```

The tests exercise local state transitions, event handling, and browser-storage behavior. They do not validate real provider access, advertising performance, or production security. Check the UI in a browser after changing layout or rendering behavior. `npm run check` runs the public-release file checks.

## Documentation

- [Architecture and workflow boundaries](docs/ARCHITECTURE.md)
- [Demo tracking rules](docs/TRACKING.md)
- [Security and responsible disclosure](SECURITY.md)

Before contributing, use synthetic fixtures and placeholder URLs. Keep credentials, customer data, personal audience data, internal documents, and browser-state exports out of commits and issues.

## License

[MIT](LICENSE). Advertising-platform names identify the workflow being demonstrated; this project is not affiliated with those platforms.

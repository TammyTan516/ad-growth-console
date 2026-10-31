# Personal Codex connector

The connector runs on each member's own computer. The shared advertising workspace creates a bounded generation job; that member's local Codex generates structured strategy/copy; the connector returns the result to the saved proposal. Human review remains a separate step. The connector cannot approve a proposal or create advertising objects.

## First connection

1. Install a supported Node.js runtime and an official Codex CLI on the member's computer. Sign in to Codex locally using the intended account. The website does not collect the Codex password, OAuth token or API key.
2. In the workspace's personal Codex connection screen, create a one-time connection code.
3. From this repository, run the command shown in the screen. For example:

   ```sh
   node runner/connect.mjs --server https://workspace.example
   ```

4. Enter the connection code at the terminal prompt. Do not include the code in a command argument or share it in a public message.
5. Return to the website, check the intended member, team and device, and confirm the pending connection. An exchanged code alone does not activate task execution.
6. Keep the connector running. In a saved proposal, choose automatic Codex generation. The connector handles only jobs assigned to its authenticated member. Inspect the returned strategy/copy and submit it for human review.

For local development on the same computer, `--server http://127.0.0.1:3000` is allowed. Colleagues on other computers need the team's reachable HTTPS workspace address; their `127.0.0.1` points to their own computer.

## Local commands

```sh
node runner/connect.mjs --check
node runner/connect.mjs --once
node runner/connect.mjs --help
```

`--check` reports only whether Codex exists, is signed in, and supports the required restricted-generation options. It does not read or print the authentication file. `--once` waits for one assigned task, acknowledges its outcome, then exits. The default mode polls for more jobs. Ctrl+C stops the local connector.

Use `--codex` with the absolute native executable path if automatic discovery does not locate the CLI. The bundled ChatGPT macOS executable is one supported location; Windows users may need the native `codex.exe` rather than a shell `.cmd` shim. No shell command string is constructed from proposal text.

The default private connection directory is `.ad-growth-console` under the current operating-system user's home. Use `--state-dir` for a separate private connection directory when connecting to another workspace. One saved directory belongs to one workspace/member/device connection. The server address must match the saved origin exactly, and redirects are refused before any credential can be forwarded.

Each private state directory permits one running connector process. A private `runner.lock` records that process and an ownership token; another terminal using the same directory is refused. Normal exit releases only the lock held by that exact process. If the process was forcibly terminated, the connector detects the stale PID but does not delete its lock automatically. After confirming that the old process has exited, explicitly run `--clear-stale-lock` with the same `--state-dir`. Cleanup never terminates a process and refuses a live PID. Do not copy the same connector credential into multiple directories or share an OS account's private connection files with another member.

To disconnect, revoke the device in the website first. Then `--forget` removes the local app credential and pending-result files. Forgetting locally does not revoke the server credential. Do not forget a connection merely to retry an uncertain submission; the pending result is deliberately retained to prevent duplicate generation.

## Credential and data boundaries

The server stores only a hash of its own scoped connector credential. The plaintext app credential stays in the member's private local connection file, with file mode `0600` and directory mode `0700` where supported. Windows deployments should restrict the directory to the intended OS account using filesystem access controls. This credential is separate from Codex authentication.

The connector does not open, copy or export Codex's auth file. It invokes the official local CLI, which reuses the saved local authentication. It preserves existing `HOME`/`CODEX_HOME` values and does not set them to an alternate credential store. API keys, database credentials and arbitrary application environment variables are not forwarded into the generation process. Account availability and quota are confirmed by the actual Codex run, not by a successful pairing alone.

The workspace login and local Codex login are independent identities. Pairing proves which workspace member confirmed the device; it does not prove that the Codex CLI account has the same email address. Members must verify the intended local Codex account themselves. The connector reports signed-in status only and makes no email-identity proof claim.

A generation job receives only the proposal's saved prompt and JSON schema. This milestone still uses material names/notes and audience summaries; it does not automatically attach image/video pixels or audience identity hashes. A later media adapter must separately implement authenticated material retrieval and supported visual inputs. No supplier document session or company database connection is passed to Codex.

## Restricted generation process

The current implementation requires CLI support for `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--output-schema`, `--output-last-message` and a read-only sandbox. It uses an empty temporary directory, ignores personal/project configuration, disables shell, apps, plugins, hooks, browser/computer access, code-mode and other available execution features, and disables web search/MCP configuration. It never uses an approval/sandbox bypass flag. Unknown or missing required capabilities cause a failure rather than falling back to unrestricted execution.

Because personal configuration is intentionally ignored, the run uses the CLI's default model/provider behavior with the member's saved authentication; it does not inherit a customized personal model, tool list or project instruction file. No model is hardcoded by the application. Managed Codex requirements can impose additional restrictions or reject the configuration. The connector does not override those requirements or promise compatibility with every managed environment.

Only a completed CLI turn with valid JSON is accepted. Unexpected tool activity, process failure, malformed output, excessive output, cancellation or a ten-minute timeout produces a failed outcome; raw stdout/stderr is not written to the website or console logs. The temporary request/schema/result directory is removed after the process ends. These controls bound the application workflow; they do not constitute a comprehensive operating-system isolation audit.

## Recovery and review

Only one generation runs per connector process. Heartbeats renew the owned job lease; a cancelled/revoked/expired lease or a failed renewal stops the local process. Each result is saved to a private outbox before submission. If the network drops after submitting, the connector retries that same result and lease; it does not invoke Codex again. Server-side idempotency decides whether the outcome was already committed.

If the proposal, request or selected resource changed, the result cannot replace the newer proposal. Rejected outcomes remain privately in `last-rejected.json` for inspection and the website exposes the task's outcome. A deliberate retry must use the website's current-version task flow. The connector never retries a rejected result against another job or lease.

Successful automatic generation fills editable strategy/copy and returns the proposal to the manual review workflow. Review, advertising creation and advertising enablement are distinct operations. This milestone does not add unattended advertising execution or spend authority.

## Verification

`tests/runner.test.mjs` uses isolated files, a synthetic subprocess and a fake workspace transport to test origin/redirect handling, private pairing state, restricted argument construction, process termination, durable result recovery, pending confirmation, lease cancellation and exclusive local process locking. These tests do not exercise a member's actual Codex account. A separately labelled live smoke test is required to claim that a particular local account completed generation.

Official references: [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli), and [Configuration reference](https://learn.chatgpt.com/docs/config-reference).

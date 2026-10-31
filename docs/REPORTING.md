# Google Ads daily reports

Phase 7 adds authenticated Google Ads account/campaign reporting to the team workspace. It never creates an advertising execution task or changes a campaign, budget, ad group, ad, keyword or paused switch. Connecting reporting is separate from the personal Codex text-generation connection.

## Private data connection

Set `GOOGLE_ADS_CONFIG_FILE` in an explicitly loaded, private environment file. Its JSON follows this structure:

```json
{
  "auth_mode": "user_oauth",
  "oauth_client_file": "credentials/oauth-client.json",
  "oauth_token_file": "credentials/oauth-token.json",
  "google_ads_customer_ids": ["1234567890"],
  "google_ads_login_customer_id": ""
}
```

The token file is a standard Google authorized-user JSON, kept outside public source with private file permissions. Reuse an existing authorized integration by referencing its configuration; do not copy its credentials into this repository. When Google returns `invalid_grant`, restore the grant using the checked helper below or a workflow that verifies the actual token save; a generic callback landing page is not proof of success. Passwords, passkeys, verification codes and credentials must never be sent in chat. The reader refreshes access tokens only in memory and never prints Google response bodies containing authorization material.

For an existing combined Analytics/Ads installed-client integration, the optional helper below restores the same `analytics.readonly` and `adwords` scopes while preserving its shared private token file. Use a Python 3.9+ environment that already has the official `google-auth-oauthlib` package installed:

```sh
python3 scripts/google_authorize.py --config /absolute/private/google-config.json --timeout 900
```

Open its authorization URL in the intended signed-in system browser; an optional `--login-hint` helps choose the existing Google account. The helper validates Google destinations, uses a short-lived loopback callback with state and PKCE checks, and disables token-exchange redirects. It does not bypass Google account or security confirmations. Its browser page says **authorization saved** only after the returned scopes, refresh token and atomic private file save succeed. A denied, incomplete or failed callback explicitly says **not saved** and preserves the old file. A saved authorization still needs a successful report read in the workspace; it is not proof of advertising-account access.

The Google OAuth `adwords` scope can permit more than reporting. This application restricts its adapter to fixed `googleAds:search` queries and the standard OAuth refresh endpoint; this is an application read-only boundary, not a claim that the Google grant itself has a narrower scope. The configured customer allowlist and installation team restriction are enforced before reading. `GOOGLE_ADS_TEAM_ID` may bind the source explicitly; otherwise the installation's first team owns it. Team viewers can read saved reports, editors can refresh existing connections, and administrators can bind allowed accounts and change the local refresh schedule. No credential value or path is exposed in these APIs.

`GOOGLE_ADS_API_VERSION` defaults to `v25`. Keep it aligned with supported Google Ads reporting fields. A configured file is not proof of a working connection; only a complete successful read creates a report.

If the machine's Google connection requires an existing HTTP(S) proxy, set `GOOGLE_ADS_HTTPS_PROXY` in the same private environment file. Node does not automatically inherit macOS system proxy preferences. This optional setting uses a scoped HTTPS agent for the fixed OAuth refresh and Google Ads search endpoints only. It does not modify the system proxy, global fetch behavior or TLS certificate checks, and it does not fall back to a direct connection after a proxy failure. Keep proxy URLs and any embedded authentication outside source control. The reader uses `campaign.start_date_time` for API v23+ and retains the account-local calendar date; older configured versions use the legacy field.

Google can show a tester or unverified-app warning during authorization. The account owner must review that warning and the requested access themselves; the reporting reader cannot accept it on their behalf. For an external OAuth app in **Testing**, Google limits test-user authorization and offline refresh tokens to seven days when non-basic scopes such as Ads are requested. This can require repeated manual authorization and is not a durable unattended deployment. Before relying on long-term daily refresh, have the app owner review the appropriate publishing/verification or organization-internal setup in Google Cloud. This project does not change that security configuration automatically. See [Google's app-audience rules](https://support.google.com/cloud/answer/15549945) and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Report scope and interpretation

- A report is one Google customer, one complete calendar day in that customer's timezone, and one currency. The default is yesterday; today and future dates are rejected.
- Costs are read in integer micros and converted once for display. CTR is clicks divided by impressions; CPC is cost divided by clicks; CPA is cost divided by positive platform-attributed conversions. A zero denominator displays an unavailable rate.
- Google platform conversions may be fractional and can include different conversion actions. The report lists those actions separately. Platform conversions are not website registered users or first subscribers, and are not deduplicated people across platforms.
- Current campaign status is captured at sync time. Historical performance is not proof of the campaign's historical switch state. A paused or not-started campaign with no delivery is not a failed creative and never triggers enablement.
- Only complete successful paginated reads can produce zero-delivery rows. A source error preserves the last successful report and exposes a readable sync failure; it never replaces missing data with zero.
- Each sync re-reads a bounded 15-day window. Existing reports in the previous seven days are refreshed for conversion backfill using the same source snapshot; report IDs remain stable and changed versions are retained. The selected daily report compares with its preceding complete day and includes an eight-day trend.
- Report snapshots retain the actual campaign IDs and associations to the execution's frozen proposal version. Changing a current draft does not relabel an older report.

Data summaries and suggested next checks are deterministic rules based on the displayed report scope. They are labelled as such, and do not pretend to be a personal Codex analysis or establish causal explanations. Suggestions remain advisory; advertising edits go through the existing proposal and human review process.

## Daily refresh

Once an administrator successfully connects an account, the default is daily at 10:00 in the account timezone. The administrator can change this time or stop daily refresh in the report page. A running server checks once a minute, catches up after restart, and limits retries after failures. Disabling the source member's team access prevents their scheduled reads.

This local server must remain running with network access. Closing the computer does not provide an always-online service. There is no email, Feishu or chat notification job, and no extra Codex app automation is created. A hosted deployment needs persistent private storage, a reviewed secret configuration and an always-available execution environment.

## Validation

Run `pnpm test:reporting` for adapter, aggregation, authorization, HTTP persistence and browser-controller tests with synthetic data. Local tests do not establish a live Google connection. Live acceptance additionally requires a successful account read, saved real daily report, reload/read-back in the browser and confirmation that the acceptance campaign remains paused.

Primary API references: [reporting overview](https://developers.google.com/google-ads/api/docs/reporting/overview), [complete pagination](https://developers.google.com/google-ads/api/docs/reporting/paging), [conversion metrics](https://developers.google.com/google-ads/api/docs/conversions/reporting).

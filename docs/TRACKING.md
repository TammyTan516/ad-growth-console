# Demo tracking rules

This repository uses generic, replaceable example rules. It does not contain a production tracking convention or connect to an analytics backend.

## Fields

| Parameter | Demo value |
| --- | --- |
| `tracking_code` | `demo-<platform>-<local sequence>`, for example `demo-google-000001` |
| `utm_source` | The selected example platform |
| `utm_medium` | The selected example advertising type |
| `utm_campaign` | `demo-campaign` |
| `utm_content` | The same demo tracking code |

For example:

```text
https://example.com/landing?tracking_code=demo-google-000001&utm_source=Google&utm_medium=Search&utm_campaign=demo-campaign&utm_content=demo-google-000001
```

The sequence is local to this browser snapshot. It is not globally unique across users, devices, deployments, or cleared browser storage.

## Confirmation and history

Choose a default landing page or a manual activity URL, then review any per-platform overrides and advertising types. Confirmation creates local tracking records for the selected platforms. Confirming the same unchanged configuration again reuses its records rather than adding duplicates.

Each record retains its proposal version, selected page version, asset references, destination, tracking code, and platform. A simulated build can backfill account, campaign, group, and ad identifiers into the matching record. This backfill does not rewrite the reviewed destination.

Changing a meaningful input requires confirming the new links and reviewing the proposal again. Updating the landing-page library alone does not replace previously frozen destinations. Historical execution records keep their original links.

The current prototype demonstrates one advertising-link slot per selected platform. The records and version references illustrate how finer-grained group or ad links could be added later; they do not claim that every possible platform format is supported.

## URL handling

The URL builder uses the browser URL parser. It replaces the parameters managed by this demo, preserves unrelated parameters, and keeps any fragment after the query string. Invalid destinations remain incomplete rather than producing a usable record.

All built-in destinations use `example.com`. Some paths are intentionally fictional. Previewing such a link does not prove that a real landing page exists or that analytics events are collected.

## Data boundaries

Keep tracking parameters free of email addresses, hashed email addresses, personal names, user identifiers, audience lists, and credentials. Audience and platform identifiers belong in protected internal mappings when a real integration is implemented.

Saving a demo link means saving it to local browser state. It does not publish an ad, configure platform tracking, validate attribution, or persist anything to a shared backend. A production extension needs an explicit rule configuration, server-assigned uniqueness, verified redirects and event collection, and a reviewed migration policy for existing links.

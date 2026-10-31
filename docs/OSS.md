# Private media storage with Alibaba Cloud OSS

The media adapter supports local storage and a private OSS bucket. OSS stores uploaded images/videos only. Team accounts, proposals, version history, audience hashes, UTM records, and review records remain in the application's SQLite database. Selecting OSS does not deploy the application or migrate that database.

## Deployment configuration

A deployment owner supplies these server-side environment variables through the host's private secret configuration:

| Name | Purpose |
| --- | --- |
| `MEDIA_STORAGE` | `local` (default) or `oss` |
| `OSS_BUCKET` | Existing private bucket name |
| `OSS_REGION` | OSS region, such as `oss-cn-hangzhou` |
| `OSS_ENDPOINT` | Optional HTTPS endpoint for that region; defaults to the region's public OSS endpoint |
| `OSS_PREFIX` | Private object prefix; defaults to `ad-growth-console` |
| `OSS_ACCESS_KEY_ID` | Scoped server-side credential identifier |
| `OSS_ACCESS_KEY_SECRET` | Scoped server-side credential secret |
| `OSS_STS_TOKEN` | Optional temporary STS session token |

Keep credentials out of browser fields, URLs, source files, Git commits, screenshots, and connector configuration. They belong to the application server, not to each colleague's Codex computer. Do not paste credential values into a public issue or chat.

The adapter uses the pinned `ali-oss` SDK with HTTPS and Signature V4. Custom public domains, arbitrary endpoints, plaintext HTTP, and cross-region endpoint mismatches are rejected. A same-region internal OSS endpoint can be configured by an operator when the application host has the required network access. See Alibaba Cloud's [initialization guidance](https://www.alibabacloud.com/help/en/oss/initialization-10).

An STS token is used as supplied. This release does not automatically obtain or refresh STS credentials; the deployment owner must provide renewed credentials and restart the service when required.

## Bucket and permissions

Create or select the bucket through the company's own Alibaba Cloud process and keep it private. The adapter does not create buckets, make objects public, change bucket policies, or delete objects. Each upload explicitly uses a private object ACL.

Scope the application identity to the configured bucket and `OSS_PREFIX/materials/` object prefix. It needs object upload/read permissions (`oss:PutObject`, `oss:GetObject`) and any object-ACL permission required by the selected bucket policy for explicit private uploads (`oss:PutObjectAcl`). Do not grant bucket administration, wildcard account-wide OSS access, or deletion permissions for this feature. An operator should validate the final RAM policy against the company's bucket configuration. See [PutObject](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject) and [object ACLs](https://www.alibabacloud.com/help/en/oss/user-guide/object-acl).

## Upload and read flow

1. A signed-in editor uploads a supported image/video to the application. Existing size, media-signature, team, and revision checks still apply.
2. The server verifies the temporary file's byte size and SHA256 fingerprint.
3. The adapter streams it to `OSS_PREFIX/materials/<team-id>/<sha256>` with known content length, media type, hash metadata, and private access. See [streaming upload](https://www.alibabacloud.com/help/en/oss/developer-reference/streaming-upload-1).
4. The server verifies the remote object size and hash metadata before saving the material version as ready. An incomplete or failed operation does not return a ready file reference.
5. Members read the file through the authenticated workspace route. The application verifies team membership and proxies the private object stream, including single byte-range video reads. It does not give the browser public or presigned OSS URLs. See [streaming download](https://www.alibabacloud.com/help/en/oss/developer-reference/streaming-download-2).

Stored file references contain the provider, bucket, region, and private object key. The public material catalog contains file metadata only. The adapter rejects references outside the requested team's expected content-addressed key.

## Status and migration

`configured` means the required configuration has a valid shape. It does not prove that credentials work or that the bucket is reachable. `ready` for OSS becomes true only after a successful object operation in the running process. No live OSS check, upload, or bucket change occurs merely by opening the workspace.

When `MEDIA_STORAGE=oss` is selected but configuration is incomplete, new uploads fail with an explicit setup error. The adapter does not silently put them on the application disk. Existing file records with no provider field are interpreted as local files and remain readable from the private data directory even after OSS is selected.

Changing bucket, region, or prefix does not migrate historical objects. Keep historical references accessible and plan a separate verified migration before changing these settings. Files referenced by retained versions must not be deleted as part of an upload or resource update.

Storage tests use temporary local files and an injected fake OSS client. They verify provider selection, private upload headers, size/hash checks, team isolation, byte ranges, and safe errors. They do not establish that a real company bucket is connected. A real upload/download acceptance pass remains necessary after the deployment owner supplies the private configuration.

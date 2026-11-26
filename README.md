# Upload to S3, R2 or B2 with Aktar

A GitHub Action that uploads files from your workflow to **your own** Amazon S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces or MinIO bucket and gives you the links: as outputs, in the job summary, and optionally as a comment on the pull request.

Good for test screenshots and visual diffs, build artifacts you want to link to, release downloads, or anything you'd rather not keep as a GitHub artifact.

## Usage

```yaml
- uses: getaktar/upload-action@v1
  with:
    files: |
      test-results/**/*.png
      dist/app.zip
    provider: r2
    account-id: ${{ secrets.R2_ACCOUNT_ID }}
    bucket: ci-uploads
    public-url: https://files.example.com
    access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}
    secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    path: "{repo}/{run}/{filename}-{short}.{ext}"
```

### Playwright screenshots on the pull request

```yaml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npx playwright test
      - if: always()
        uses: getaktar/upload-action@v1
        with:
          files: test-results/**/*.png
          fail-on-empty: false
          comment: true
          comment-title: Screenshots
          provider: s3
          endpoint: https://s3.eu-central-1.amazonaws.com
          region: eu-central-1
          bucket: my-ci-screenshots
          public-url: https://my-ci-screenshots.s3.eu-central-1.amazonaws.com
          access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          path: "{repo}/pr-{branch}/{run}/{filename}.{ext}"
```

The comment is updated on every run instead of adding a new one.

### Using the links in later steps

```yaml
- id: upload
  uses: getaktar/upload-action@v1
  with: { files: dist/app.zip, ... }
- run: echo "Download: ${{ steps.upload.outputs.url }}"
```

## Inputs

| Input | Required | Default | |
|---|---|---|---|
| `files` | yes | | Paths or glob patterns relative to the workspace, one per line or comma separated. |
| `bucket` | yes | | The bucket's name. |
| `public-url` | yes | | The address links start with: your domain or the bucket's public URL. |
| `access-key-id` | yes | | From a repository secret. |
| `secret-access-key` | yes | | From a repository secret. |
| `provider` | | `other` | `r2`, `s3`, `b2`, `spaces`, `minio` or `other`. Sets the region default, path-style addressing, and whether names are reserved with conditional writes (R2, S3). |
| `endpoint` | | | The S3 endpoint. Not needed for R2 when `account-id` is set. |
| `account-id` | | | Cloudflare account ID, for R2's endpoint. |
| `region` | | `us-east-1` on S3, `auto` elsewhere | |
| `session-token` | | | For temporary credentials, for example from `aws-actions/configure-aws-credentials`. |
| `path` | | `{year}/{month}/{short}.{ext}` | Where files go. Variables: `{repo}` `{branch}` `{sha}` `{run}` `{attempt}` `{year}` `{month}` `{day}` `{date}` `{time}` `{filename}` `{ext}` `{short}` `{uuid}` `{random}` `{sha256}`. |
| `path-style` | | on for MinIO | `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. |
| `fail-on-empty` | | `true` | Fail when nothing matches. |
| `comment` | | `false` | Comment the links on the pull request (needs `pull-requests: write`). |
| `comment-title` | | `Uploaded files` | Heading of the comment and the job summary. |
| `github-token` | | `github.token` | Token for the comment. |

## Outputs

| Output | |
|---|---|
| `urls` | The links, one per line. |
| `url` | The first link. |
| `markdown` | Markdown for every file, images embedded. |
| `json` | `[{ "file", "name", "url", "key", "size" }]` |

## How files are named

`{short}` is a 7-character code that never replaces another file: on R2 and S3 the name is reserved with a conditional write, elsewhere it's checked first. With a fixed `path` (no `{short}`, `{uuid}`, `{random}` or `{sha256}`), a name that's taken gets " 2", " 3" and so on. Text files are sent as UTF-8 and location data is removed from photos, the same as the [Aktar](https://getaktar.com) apps.

## Security

The secret key is masked in the log. Files go straight from the runner to your bucket; there's no Aktar server in between. Give the key access to one bucket only, and use a lifecycle rule if CI uploads should expire.

## About Aktar

[Aktar](https://getaktar.com) is a free uploader for your own bucket on macOS, Windows, Linux, iOS and Android, with a CLI, an MCP server, and extensions for browsers, VS Code, Raycast and Obsidian.

## Development

```bash
pnpm install
pnpm check   # typecheck, bundle into dist/, tests (against MinIO when installed), shared-code check
```

`dist/index.js` is committed: the runner runs it as is. Rebuild it with `pnpm build` before committing a change to `src/`.

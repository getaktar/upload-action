import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { glob, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isImageFilename } from './core/contentType.ts';
import { DEFAULT_KEY_TEMPLATE } from './core/objectKey.ts';
import { deriveR2Endpoint, errorMessage, presetDefaultForcePathStyle, presetDefaultRegion, type DestinationConfig, type ProviderPreset, type StorageCredentials } from './core/types.ts';
import { normalizeBaseURL } from './core/publicUrl.ts';
import { S3Client, type HttpClient } from './s3/client.ts';
import { uploadFile } from './upload/uploader.ts';

export type Env = Record<string, string | undefined>;

/** An input as the runner passes it: `INPUT_<NAME>` with spaces as underscores, upper case. */
export function input(env: Env, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const value = input(env, name).toLowerCase();
  if (!value) return fallback;
  if (['true', 'yes', '1', 'on'].includes(value)) return true;
  if (['false', 'no', '0', 'off'].includes(value)) return false;
  throw new Error(`"${name}" must be true or false, not "${value}".`);
}

const PROVIDERS: Record<string, ProviderPreset> = {
  r2: 'cloudflareR2',
  cloudflare: 'cloudflareR2',
  s3: 'amazonS3',
  aws: 'amazonS3',
  b2: 'backblazeB2',
  backblaze: 'backblazeB2',
  spaces: 'digitalOceanSpaces',
  digitalocean: 'digitalOceanSpaces',
  minio: 'minIO',
  other: 'customS3',
};

export interface Settings {
  destination: DestinationConfig;
  credentials: StorageCredentials;
  patterns: string[];
  template: string;
  failOnEmpty: boolean;
  comment: boolean;
  commentTitle: string;
}

export function readSettings(env: Env): Settings {
  const providerName = input(env, 'provider').toLowerCase() || 'other';
  const preset = PROVIDERS[providerName];
  if (!preset) throw new Error(`Unknown provider "${providerName}". Use one of: ${Object.keys(PROVIDERS).join(', ')}.`);
  const accountId = input(env, 'account-id');
  let endpoint = input(env, 'endpoint');
  if (!endpoint && accountId) endpoint = deriveR2Endpoint(accountId);
  if (!endpoint) throw new Error('Set "endpoint" (or "account-id" for Cloudflare R2).');
  const bucket = input(env, 'bucket');
  if (!bucket) throw new Error('Set "bucket".');
  const publicURL = input(env, 'public-url');
  if (!/^https?:\/\//i.test(publicURL)) throw new Error('Set "public-url" to the address links start with, such as https://files.example.com.');
  const accessKeyId = input(env, 'access-key-id');
  const secretAccessKey = input(env, 'secret-access-key');
  if (!accessKeyId || !secretAccessKey) throw new Error('Set "access-key-id" and "secret-access-key" from your repository secrets.');
  const patterns = input(env, 'files')
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (patterns.length === 0) throw new Error('Set "files" to the files to upload: paths or glob patterns, one per line.');
  const pathStyle = input(env, 'path-style');
  return {
    destination: {
      id: 'ACTION',
      name: bucket,
      preset,
      accountID: accountId || null,
      endpoint: endpoint.replace(/\/+$/, ''),
      region: input(env, 'region') || presetDefaultRegion(preset),
      bucket,
      publicBaseURL: normalizeBaseURL(publicURL).replace(/\/+$/, ''),
      objectPathTemplate: input(env, 'path') || DEFAULT_KEY_TEMPLATE,
      forcePathStyle: pathStyle ? flag(env, 'path-style', false) : presetDefaultForcePathStyle(preset),
    },
    credentials: { accessKeyId, secretAccessKey, sessionToken: input(env, 'session-token') || null },
    patterns,
    template: input(env, 'path') || DEFAULT_KEY_TEMPLATE,
    failOnEmpty: flag(env, 'fail-on-empty', true),
    comment: flag(env, 'comment', false),
    commentTitle: input(env, 'comment-title') || 'Uploaded files',
  };
}

/** Variables only the action knows, filled in before the usual ones: {repo}, {branch}, {sha}, {run}, {attempt}. */
export function fillWorkflowVariables(template: string, env: Env): string {
  const clean = (value: string | undefined) => (value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const repo = (env.GITHUB_REPOSITORY ?? '').split('/').pop();
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  return template
    .replaceAll('{repo}', clean(repo) || 'repo')
    .replaceAll('{branch}', clean(branch) || 'branch')
    .replaceAll('{sha}', (env.GITHUB_SHA ?? '').slice(0, 7) || 'sha')
    .replaceAll('{run}', clean(env.GITHUB_RUN_ID) || 'run')
    .replaceAll('{attempt}', clean(env.GITHUB_RUN_ATTEMPT) || '1');
}

/** Files matching the patterns (relative to `cwd`), each once, in pattern order, directories left out. */
export async function findFiles(patterns: string[], cwd: string): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for await (const match of glob(pattern, { cwd })) {
      const full = path.resolve(cwd, match);
      if (seen.has(full)) continue;
      if (!(await stat(full)).isFile()) continue;
      seen.add(full);
      found.push(full);
    }
  }
  return found;
}

export interface Upload {
  file: string;
  name: string;
  url: string;
  key: string;
  size: number;
}

export function markdownFor(uploads: Upload[]): string {
  return uploads
    .map((u) => {
      const label = u.name.replace(/([\\[\]])/g, '\\$1');
      return isImageFilename(u.name) ? `![${label}](${u.url})` : `[${label}](${u.url})`;
    })
    .join('\n');
}

/** Appends an output, using a heredoc delimiter so values can span lines. */
function setOutput(env: Env, name: string, value: string): void {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `aktar_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export const fetchHttp: HttpClient = async (request) => {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  const arrayBuffer = await response.arrayBuffer();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key] = value));
  return { status: response.status, headers, text: new TextDecoder().decode(arrayBuffer), arrayBuffer };
};

const MARKER = '<!-- aktar-upload-action -->';

/** Adds (or updates) one comment on the pull request this run is for. */
async function commentOnPullRequest(env: Env, title: string, uploads: Upload[]): Promise<void> {
  const token = input(env, 'github-token');
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!token || !eventPath || !env.GITHUB_REPOSITORY) {
    console.log('::warning::"comment" needs a github-token and a pull_request event; skipped.');
    return;
  }
  const event = JSON.parse(await readFile(eventPath, 'utf8')) as { pull_request?: { number?: number }; number?: number };
  const number = event.pull_request?.number;
  if (!number) {
    console.log('::notice::This run isn\'t for a pull request, so there is nothing to comment on.');
    return;
  }
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
  const body = `${MARKER}\n### ${title}\n\n${markdownFor(uploads)}\n`;
  const list = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/issues/${number}/comments?per_page=100`, { headers });
  if (!list.ok) throw new Error(`Couldn't read the pull request's comments (HTTP ${list.status}). Give the job "pull-requests: write".`);
  const mine = ((await list.json()) as { id: number; body?: string }[]).find((c) => c.body?.startsWith(MARKER));
  const response = mine
    ? await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/issues/comments/${mine.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) })
    : await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/issues/${number}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });
  if (!response.ok) throw new Error(`Couldn't comment on the pull request (HTTP ${response.status}). Give the job "pull-requests: write".`);
}

export async function run(env: Env = process.env, http: HttpClient = fetchHttp): Promise<Upload[]> {
  const settings = readSettings(env);
  // Secrets never show in the log, even if a later line would print them.
  console.log(`::add-mask::${settings.credentials.secretAccessKey}`);
  const cwd = env.GITHUB_WORKSPACE || process.cwd();
  const files = await findFiles(settings.patterns, cwd);
  if (files.length === 0) {
    const message = `No files match ${settings.patterns.map((p) => `"${p}"`).join(', ')}.`;
    if (settings.failOnEmpty) throw new Error(message);
    console.log(`::warning::${message}`);
  }
  const client = new S3Client(settings.destination, settings.credentials, http);
  const template = fillWorkflowVariables(settings.template, env);
  const uploads: Upload[] = [];
  for (const file of files) {
    const data = await readFile(file);
    const outcome = await uploadFile({
      data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      filename: path.basename(file),
      destination: settings.destination,
      client,
      template,
      workspace: { workspace: '', document: '', documentFolder: '' },
      removeLocation: true,
    });
    uploads.push({ file: path.relative(cwd, file), name: outcome.filename, url: outcome.url, key: outcome.key, size: outcome.byteSize });
    console.log(`${path.relative(cwd, file)} -> ${outcome.url}`);
  }

  setOutput(env, 'urls', uploads.map((u) => u.url).join('\n'));
  setOutput(env, 'url', uploads[0]?.url ?? '');
  setOutput(env, 'markdown', markdownFor(uploads));
  setOutput(env, 'json', JSON.stringify(uploads));
  if (env.GITHUB_STEP_SUMMARY && uploads.length > 0) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${settings.commentTitle}\n\n${markdownFor(uploads)}\n\n`);
  }
  if (settings.comment && uploads.length > 0) await commentOnPullRequest(env, settings.commentTitle, uploads);
  return uploads;
}

export async function main(): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.log(`::error::${errorMessage(error).replace(/\r?\n/g, '%0A')}`);
    process.exitCode = 1;
  }
}

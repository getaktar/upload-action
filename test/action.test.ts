import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { fillWorkflowVariables, findFiles, markdownFor, readSettings, run, type Env } from '../src/action.ts';
import { EMPTY_PAYLOAD_HASH, signRequest } from '../src/s3/sigv4.ts';

const base: Env = {
  INPUT_FILES: 'shots/*.png\nreport.txt',
  INPUT_BUCKET: 'ci-uploads',
  INPUT_ENDPOINT: 'https://s3.us-east-1.amazonaws.com/',
  'INPUT_PUBLIC-URL': 'https://files.example.com/',
  'INPUT_ACCESS-KEY-ID': 'AKIA',
  'INPUT_SECRET-ACCESS-KEY': 'secret',
};

test('settings: defaults, providers and errors', () => {
  const s = readSettings({ ...base, INPUT_PROVIDER: 's3' });
  assert.equal(s.destination.preset, 'amazonS3');
  assert.equal(s.destination.region, 'us-east-1');
  assert.equal(s.destination.endpoint, 'https://s3.us-east-1.amazonaws.com');
  assert.equal(s.destination.publicBaseURL, 'https://files.example.com');
  assert.deepEqual(s.patterns, ['shots/*.png', 'report.txt']);
  assert.equal(s.template, '{year}/{month}/{short}.{ext}');
  assert.equal(s.failOnEmpty, true);
  assert.equal(s.comment, false);

  const r2 = readSettings({ ...base, INPUT_ENDPOINT: '', INPUT_PROVIDER: 'r2', 'INPUT_ACCOUNT-ID': '0123456789abcdef0123456789abcdef' });
  assert.equal(r2.destination.endpoint, 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com');
  assert.equal(r2.destination.region, 'auto');

  assert.equal(readSettings({ ...base, INPUT_PROVIDER: 'minio' }).destination.forcePathStyle, true);
  assert.equal(readSettings({ ...base, 'INPUT_PATH-STYLE': 'true' }).destination.forcePathStyle, true);
  assert.throws(() => readSettings({ ...base, INPUT_PROVIDER: 'ftp' }), /Unknown provider/);
  assert.throws(() => readSettings({ ...base, 'INPUT_PUBLIC-URL': 'files.example.com' }), /public-url/);
  assert.throws(() => readSettings({ ...base, INPUT_FILES: '' }), /"files"/);
  assert.throws(() => readSettings({ ...base, INPUT_COMMENT: 'maybe' }), /true or false/);
});

test('workflow variables', () => {
  const env = { GITHUB_REPOSITORY: 'getaktar/site', GITHUB_HEAD_REF: 'feature/new home', GITHUB_SHA: '0123456789abcdef', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' };
  assert.equal(fillWorkflowVariables('ci/{repo}/{branch}/{sha}/{run}-{attempt}/{filename}.{ext}', env), 'ci/site/feature-new-home/0123456/42-2/{filename}.{ext}');
  assert.equal(fillWorkflowVariables('{repo}/{branch}', {}), 'repo/branch');
});

test('markdown embeds images and links other files', () => {
  assert.equal(
    markdownFor([
      { file: 'a.png', name: 'a [1].png', url: 'https://f/a.png', key: 'a.png', size: 1 },
      { file: 'r.txt', name: 'r.txt', url: 'https://f/r.txt', key: 'r.txt', size: 1 },
    ]),
    '![a \\[1\\].png](https://f/a.png)\n[r.txt](https://f/r.txt)',
  );
});

test('files: globs, each file once, no directories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aktar-action-files-'));
  mkdirSync(join(dir, 'shots', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'shots', 'a.png'), 'a');
  writeFileSync(join(dir, 'shots', 'nested', 'b.png'), 'b');
  writeFileSync(join(dir, 'report.txt'), 'r');
  const found = await findFiles(['shots/**/*.png', 'shots/a.png', 'report.txt', 'shots'], dir);
  assert.deepEqual(found.map((f) => f.slice(dir.length + 1)).sort(), ['report.txt', 'shots/a.png', 'shots/nested/b.png']);
  rmSync(dir, { recursive: true, force: true });
});

// MARK: Against MinIO

const hasMinio = spawnSync('which', ['minio']).status === 0;
let minio: ChildProcess | null = null;
let dataDir = '';
let endpoint = '';

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

before(async () => {
  if (!hasMinio) return;
  const port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), 'aktar-action-minio-'));
  minio = spawn('minio', ['server', dataDir, '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${await freePort()}`, '--quiet'], {
    env: { ...process.env, MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' },
    stdio: 'ignore',
  });
  endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${endpoint}/minio/health/live`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const headers = signRequest({ method: 'PUT', host: `127.0.0.1:${port}`, path: '/ci-uploads', query: [], headers: {}, payloadHash: EMPTY_PAYLOAD_HASH }, { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }, 'us-east-1');
  const created = await fetch(`${endpoint}/ci-uploads`, { method: 'PUT', headers });
  assert.ok(created.ok, `bucket created (${created.status} ${await created.text()})`);
});

after(async () => {
  if (minio && minio.exitCode === null) {
    const exited = once(minio, 'exit');
    minio.kill();
    await exited;
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('a run uploads every match and writes outputs and the summary', { skip: !hasMinio }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'aktar-action-ws-'));
  mkdirSync(join(workspace, 'shots'));
  writeFileSync(join(workspace, 'shots', 'home.png'), Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex'));
  writeFileSync(join(workspace, 'report.txt'), 'Çağrı: 12 passed\n');
  const outputs = join(workspace, 'outputs');
  const summary = join(workspace, 'summary.md');
  writeFileSync(outputs, '');
  writeFileSync(summary, '');
  const uploads = await run({
    ...base,
    INPUT_PROVIDER: 'minio',
    INPUT_ENDPOINT: endpoint,
    INPUT_REGION: 'us-east-1',
    'INPUT_PUBLIC-URL': `${endpoint}/ci-uploads`,
    'INPUT_ACCESS-KEY-ID': 'minioadmin',
    'INPUT_SECRET-ACCESS-KEY': 'minioadmin',
    INPUT_PATH: 'runs/{run}/{filename}-{short}.{ext}',
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputs,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_RUN_ID: '777',
  });
  assert.equal(uploads.length, 2);
  assert.match(uploads[0].url, new RegExp(`^${endpoint}/ci-uploads/runs/777/home-[0-9A-Za-z]{7}\\.png$`));
  const text = await fetch(uploads[1].url, { headers: signRequest({ method: 'GET', host: new URL(endpoint).host, path: new URL(uploads[1].url).pathname, query: [], headers: {}, payloadHash: EMPTY_PAYLOAD_HASH }, { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' }, 'us-east-1') });
  assert.equal(text.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await text.text(), 'Çağrı: 12 passed\n');
  const out = readFileSync(outputs, 'utf8');
  assert.match(out, /^urls<<aktar_[0-9a-f-]+\nhttp/m);
  assert.ok(out.includes(uploads[0].url) && out.includes(uploads[1].url));
  assert.match(out, /"name":"report\.txt"/);
  assert.match(readFileSync(summary, 'utf8'), /^### Uploaded files\n\n!\[home\.png\]/);
  rmSync(workspace, { recursive: true, force: true });
});

test('no match fails unless told not to', { skip: !hasMinio }, async () => {
  const env = { ...base, INPUT_FILES: 'nothing/*.png', INPUT_PROVIDER: 'minio', INPUT_ENDPOINT: endpoint, 'INPUT_ACCESS-KEY-ID': 'minioadmin', 'INPUT_SECRET-ACCESS-KEY': 'minioadmin', GITHUB_WORKSPACE: tmpdir() };
  await assert.rejects(run(env), /No files match/);
  assert.deepEqual(await run({ ...env, 'INPUT_FAIL-ON-EMPTY': 'false' }), []);
});

test('the bundled dist/index.js runs the way the runner starts it', { skip: !hasMinio }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'aktar-action-dist-'));
  writeFileSync(join(workspace, 'build.zip'), 'zip');
  const outputs = join(workspace, 'outputs');
  writeFileSync(outputs, '');
  const env = {
    ...process.env,
    ...base,
    INPUT_FILES: '*.zip',
    INPUT_PROVIDER: 'minio',
    INPUT_ENDPOINT: endpoint,
    'INPUT_PUBLIC-URL': `${endpoint}/ci-uploads`,
    'INPUT_ACCESS-KEY-ID': 'minioadmin',
    'INPUT_SECRET-ACCESS-KEY': 'minioadmin',
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: outputs,
  } as Record<string, string>;
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'dist', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stdout);
  assert.match(stdout, /::add-mask::minioadmin/);
  assert.match(stdout, /build\.zip -> http:\/\/127\.0\.0\.1:\d+\/ci-uploads\/\d{4}\/\d{2}\/[0-9A-Za-z]{7}\.zip/);
  assert.match(readFileSync(outputs, 'utf8'), /^url<<aktar_/m);

  const failing = spawn(process.execPath, [join(import.meta.dirname, '..', 'dist', 'index.js')], { env: { ...env, INPUT_FILES: 'missing/*' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let failOut = '';
  failing.stdout.on('data', (chunk) => (failOut += chunk));
  const [failCode] = await once(failing, 'exit');
  assert.equal(failCode, 1);
  assert.match(failOut, /::error::No files match "missing\/\*"/);
  rmSync(workspace, { recursive: true, force: true });
});

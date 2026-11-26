import { deletingPathExtension, pathExtension } from './contentType.ts';
import { makeShortCode, shortCodeFromHash, usesShortCode } from './shortKeys.ts';

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** The template used when neither the setting nor the destination gives one. */
export const DEFAULT_KEY_TEMPLATE = '{year}/{month}/{short}.{ext}';

/** What the editor-specific variables are filled with. */
export interface WorkspaceContext {
  /** The workspace folder's name ("" outside a workspace). */
  workspace: string;
  /** The open document's base name, without its extension ("" when none). */
  document: string;
  /** The document's folder inside the workspace ("" at its root). */
  documentFolder: string;
}

/** Without control characters (U+0000 to U+001F and U+007F). */
export function withoutControlCharacters(text: string): string {
  return Array.from(text)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
}

/**
 * A name as it may go into a generated key: no slashes, backslashes or
 * control characters, so a variable can't add folders or climb out of the
 * template's path. A name left empty, "." or ".." is "file".
 */
export function sanitizeFilename(name: string): string {
  const cleaned = withoutControlCharacters(name.replace(/[/\\]/g, '')).trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

/** A workspace folder as a key path: each segment cleaned, empty ones dropped. */
function sanitizeFolder(folder: string): string {
  return folder
    .split('/')
    .map((segment) => withoutControlCharacters(segment).trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}

/**
 * Why a key or prefix can't be used, or null when it can: no leading "/",
 * no empty, "." or ".." segments and no control characters. One trailing
 * "/" (a folder) is fine.
 */
export function invalidKeyReason(key: string): string | null {
  const segments = key.replace(/\/$/, '').split('/');
  if (key.startsWith('/') || withoutControlCharacters(key) !== key || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'invalid';
  }
  return null;
}

export interface KeyOptions {
  date?: Date;
  workspace?: WorkspaceContext;
  /** Lowercase hex SHA-256 of the bytes; needed for {sha256}, and makes {short} stable. */
  sha256?: string;
  shortCode?: () => string;
}

function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

/**
 * The key for an upload: the template with its variables filled in. The
 * variables are the Aktar apps' ({year} {month} {day} {date} {time}
 * {filename} {uuid} {random} {short} {ext} {sha256}) plus three for the
 * editor: {workspace}, {document} and {documentFolder}.
 *
 * With `sha256` given, {short} comes from the hash rather than chance, so
 * the same file always gets the same key.
 */
export function generateObjectKey(template: string, originalFilename: string, options: KeyOptions = {}): string {
  const filename = sanitizeFilename(originalFilename);
  const date = options.date ?? new Date();
  const year = pad(date.getFullYear(), 4);
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const workspace = options.workspace;
  const short = !usesShortCode(template)
    ? ''
    : options.sha256
      ? shortCodeFromHash(options.sha256)
      : (options.shortCode ?? makeShortCode)();

  const replacements: [string, string][] = [
    ['{year}', year],
    ['{month}', month],
    ['{day}', day],
    ['{date}', `${year}-${month}-${day}`],
    ['{time}', time],
    ['{workspace}', workspace?.workspace ? sanitizeFilename(workspace.workspace) : ''],
    ['{documentFolder}', sanitizeFolder(workspace?.documentFolder ?? '')],
    ['{document}', workspace?.document ? sanitizeFilename(workspace.document) : ''],
    ['{filename}', deletingPathExtension(filename)],
    ['{uuid}', crypto.randomUUID().toLowerCase()],
    ['{random}', randomHex(8)],
    ['{short}', short],
    ['{ext}', pathExtension(filename).toLowerCase()],
    ['{sha256}', options.sha256 ?? ''],
  ];

  let result = template;
  for (const [token, value] of replacements) result = result.split(token).join(value);
  // An empty {workspace}, {documentFolder} or {document} mustn't leave "a//b" or a leading "/".
  result = result.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  // A file without an extension mustn't end in "name.".
  return result.replace(/\.(?=$|\/)/g, '');
}

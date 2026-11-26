/**
 * English strings are the keys. The extension hands in VS Code's own
 * translator (`vscode.l10n.t`) at activation; without one (tests) the
 * English text is used. `{0}`, `{1}`... are filled with the arguments.
 */
type Translator = (key: string, ...args: (string | number)[]) => string;

function fill(text: string, args: (string | number)[]): string {
  return args.length === 0
    ? text
    : text.replace(/\{(\d+)\}/g, (match, index: string) => {
        const value = args[Number(index)];
        return value === undefined ? match : String(value);
      });
}

let translator: Translator = (key, ...args) => fill(key, args);

export function setTranslator(next: Translator): void {
  translator = next;
}

export function t(key: string, ...args: (string | number)[]): string {
  return translator(key, ...args);
}

/** "1 file" / "3 files", with the count filled in. */
export function plural(count: number, one: string, many: string): string {
  return t(count === 1 ? one : many, count);
}

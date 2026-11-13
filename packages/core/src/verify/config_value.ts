// packages/core/src/verify/config_value.ts
//
// A3-2 (research 04 finding 9, probe E7). The `config_value` edit: change one value of one key in a text file. Pure: no I/O.
//
// The earlier version matched the key with line.includes(key), the value with line.includes(old_value), and replaced the first
// occurrence of the value in the whole line. That could land on the wrong text and still report success:
//   retry1: 1            key retry1, old 1, new 9   became   retry9: 1      (the value sits inside the key)
//   # port: 80 is default                                    was edited     (a comment that names the key)
//   port: 5              old 5, new 50, applied twice        became  port: 500
// The rules now, all of them refusals rather than guesses:
//   1. Comment lines (#, //, ;, /*, a leading * ) are never edited and never count as the key's line.
//   2. The key is a whole name: the character before it is not part of a name (a letter, digit, underscore or hyphen) and the
//      character after it is not either (nor a dot, so `timeout.ms` is a different key from `timeout`). A dot before it is
//      allowed, because `config.timeout = 30` is the same key.
//   3. The old value must be the value of that key: it follows the key, a separator (`:`, `=`, `:=`, `=>`, an optional type
//      annotation, or plain spaces when the key starts the line) and an optional opening quote. Anything after the value,
//      including a trailing comment, is left alone.
//   4. The old value is a whole value: when it ends in a letter, digit or underscore, the next character may not continue a
//      number or a word. So `80` does not match `8080` or `80.5`, and a repeated application of 5 -> 50 is refused the second time.
//   5. Exactly one place may match. Two lines, or two spots on one line, is ambiguous.
// This is still a text edit, not a config parser. A value that is split over lines, an inline table, or a key written in
// dotted form that the file spells in nested sections is refused with a reason, which sends the change down the prompt_text path.

export type ConfigValueResult = { ok: true; content: string } | { ok: false; reason: string };

const COMMENT_LINE = /^\s*(?:#|\/\/|;|\/\*|\*(?:\s|$))/;
const BEFORE_NAME_CHAR = /[A-Za-z0-9_-]/;
const AFTER_NAME_CHAR = /[A-Za-z0-9_.-]/;
const VALUE_CONTINUES = /[A-Za-z0-9_.+-]/;
const QUOTE = /["'`]/;

// After the key: an optional closing quote of a quoted key, then a separator. A typed declaration (`: number = `) is allowed.
const TYPED_SEPARATOR = /^["'`]?[ \t]*:[ \t]*[A-Za-z_$][\w$<>[\]|,. ?]*?[ \t]*(?::=|=>|=)[ \t]*/;
const PLAIN_SEPARATOR = /^["'`]?[ \t]*(?::=|=>|=|:)[ \t]*/;
const SPACE_SEPARATOR = /^[ \t]+/;

/** Where the old value starts in `line`, if it is the value of the key found at `keyAt`; otherwise -1. */
function valueStart(line: string, keyAt: number, key: string, oldValue: string): number {
  const afterKey = keyAt + key.length;
  const rest = line.slice(afterKey);
  let sepLen = 0;
  const m = TYPED_SEPARATOR.exec(rest) ?? PLAIN_SEPARATOR.exec(rest);
  if (m) sepLen = m[0].length;
  else if (line.slice(0, keyAt).trim() === "") {
    const s = SPACE_SEPARATOR.exec(rest); // a directive: `worker_connections 1024;`
    if (s) sepLen = s[0].length;
  }
  if (sepLen === 0) return -1;
  const at = afterKey + sepLen;
  // The value may be quoted in the file while the edit names it bare (30 for "30"); the edit may also name the quotes itself.
  const starts = QUOTE.test(line[at] ?? "") ? [at, at + 1] : [at];
  for (const s of starts) {
    if (!line.startsWith(oldValue, s)) continue;
    const next = line[s + oldValue.length];
    if (/[A-Za-z0-9_]$/.test(oldValue) && next !== undefined && VALUE_CONTINUES.test(next)) continue;
    return s;
  }
  return -1;
}

export function applyConfigValue(content: string, key: string, oldValue: string, newValue: string): ConfigValueResult {
  if (key.length === 0) return { ok: false, reason: "the config edit names no key" };
  if (oldValue.length === 0) return { ok: false, reason: `key "${key}": old_value is empty, so there is nothing to replace` };

  const lines = content.split("\n");
  let nameHits = 0; // whole-name occurrences of the key on lines that are not comments
  let commentHits = 0;
  let alreadyHas = 0; // key occurrences whose value is already the new value
  const matches: { line: number; at: number }[] = [];

  lines.forEach((line, i) => {
    const comment = COMMENT_LINE.test(line);
    for (let from = line.indexOf(key); from !== -1; from = line.indexOf(key, from + 1)) {
      const before = line[from - 1];
      const after = line[from + key.length];
      if (before !== undefined && BEFORE_NAME_CHAR.test(before)) continue;
      if (after !== undefined && AFTER_NAME_CHAR.test(after)) continue;
      if (comment) {
        commentHits++;
        continue;
      }
      nameHits++;
      const at = valueStart(line, from, key, oldValue);
      if (at >= 0) matches.push({ line: i, at });
      else if (newValue !== oldValue && valueStart(line, from, key, newValue) >= 0) alreadyHas++;
    }
  });

  if (matches.length === 0) {
    if (alreadyHas > 0) {
      return { ok: false, reason: `key "${key}" already has the value "${newValue}": this edit looks already applied, so nothing was changed` };
    }
    if (nameHits > 0) {
      return { ok: false, reason: `key "${key}" found, but old_value "${oldValue}" doesn't appear on that line as its value` };
    }
    if (commentHits > 0) {
      return { ok: false, reason: `key "${key}" appears only in comment lines, and comments are never edited, so nothing was changed` };
    }
    if (content.includes(key)) {
      return { ok: false, reason: `key "${key}" not found in file as a whole name (it only appears inside longer names)` };
    }
    return { ok: false, reason: `key "${key}" not found in file` };
  }
  if (matches.length > 1) {
    return { ok: false, reason: `key "${key}" with old_value "${oldValue}" is ambiguous — matches ${matches.length} places` };
  }

  const { line: i, at } = matches[0]!;
  const line = lines[i]!;
  lines[i] = line.slice(0, at) + newValue + line.slice(at + oldValue.length);
  return { ok: true, content: lines.join("\n") };
}

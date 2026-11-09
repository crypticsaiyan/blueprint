// Splits SQL text into statements without parsing it: quotes, E-strings,
// dollar quotes and comments are skipped so a `;` inside them does not count.

export interface Statement {
  /** Whitespace and comments before the statement. */
  lead: string;
  /** The statement itself, ending in `;`. */
  body: string;
}

/** Index just past a quoted token starting at `i`, or -1 when none starts there. */
export function skipQuoted(s: string, i: number): number {
  const ch = s[i];
  if (ch !== "'" && ch !== '"') return -1;
  const escapes = ch === "'" && /[eE]/.test(s[i - 1] ?? "") && !/[\w$]/.test(s[i - 2] ?? "");
  let j = i + 1;
  while (j < s.length) {
    if (escapes && s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === ch) {
      if (s[j + 1] === ch) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  return s.length;
}

export function splitStatements(sql: string): { statements: Statement[]; tail: string } {
  const statements: Statement[] = [];
  let start = 0;
  let bodyStart = -1;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (bodyStart < 0) {
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      bodyStart = i;
    }
    const quoted = skipQuoted(sql, i);
    if (quoted >= 0) {
      i = quoted;
      continue;
    }
    if (ch === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
        continue;
      }
    }
    if (ch === ";") {
      statements.push({ lead: sql.slice(start, bodyStart), body: sql.slice(bodyStart, i + 1) });
      start = i + 1;
      bodyStart = -1;
    }
    i += 1;
  }
  return { statements, tail: sql.slice(start) };
}

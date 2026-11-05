// A small, conservative POSIX-shell lexer used to classify commands before
// they run. It is not a full shell parser: anything it does not understand is
// reported through flags so the classifier can fall back to "needs approval".

export interface Redirect {
  op: string;
  target: string;
  fd?: string;
}

export interface Segment {
  words: string[];
  redirects: Redirect[];
}

export interface ParseFlags {
  substitution: boolean;
  processSubstitution: boolean;
  background: boolean;
  subshell: boolean;
  group: boolean;
  heredoc: boolean;
  parseError: boolean;
  variable: boolean;
  glob: boolean;
}

export interface ParseResult {
  segments: Segment[];
  /** operators[i] is the control operator that follows segments[i]. */
  operators: string[];
  flags: ParseFlags;
  /** Bodies of $(...), `...`, <(...) and >(...) — analysed recursively by the classifier. */
  inner: string[];
  /** Heredoc bodies (data, not commands). */
  heredocs: string[];
}

/** Finds the index of the `)` matching an opening `(` whose content starts at `start`. */
function findClosingParen(input: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < input.length) {
    const c = input[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\') i++;
        i++;
      }
      if (i >= input.length) return -1;
      i++;
      continue;
    }
    if (c === '`') {
      const end = findClosingBacktick(input, i + 1);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function findClosingBacktick(input: string, start: number): number {
  let i = start;
  while (i < input.length) {
    if (input[i] === '\\') {
      i += 2;
      continue;
    }
    if (input[i] === '`') return i;
    i++;
  }
  return -1;
}

const VAR_START = /[A-Za-z_{@*#?$!0-9-]/;

export function parseShell(input: string): ParseResult {
  const segments: Segment[] = [];
  const operators: string[] = [];
  const inner: string[] = [];
  const heredocs: string[] = [];
  const flags: ParseFlags = {
    substitution: false,
    processSubstitution: false,
    background: false,
    subshell: false,
    group: false,
    heredoc: false,
    parseError: false,
    variable: false,
    glob: false,
  };

  let words: string[] = [];
  let redirects: Redirect[] = [];
  let cur = '';
  let inWord = false;
  let pendingRedirect: { op: string; fd?: string } | null = null;
  const pendingHeredocs: { delim: string; stripTabs: boolean }[] = [];

  const pushWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      redirects.push({ ...pendingRedirect, target: cur });
      if (pendingRedirect.op === '<<' || pendingRedirect.op === '<<-') {
        pendingHeredocs.push({ delim: cur, stripTabs: pendingRedirect.op === '<<-' });
      }
      pendingRedirect = null;
    } else {
      words.push(cur);
    }
    cur = '';
    inWord = false;
  };

  const endSegment = (op?: string) => {
    pushWord();
    if (pendingRedirect) {
      flags.parseError = true;
      pendingRedirect = null;
    }
    if (words.length || redirects.length) {
      segments.push({ words, redirects });
      operators.push(op ?? '');
    } else if (op === '|' || op === '|&' || op === '&&' || op === '||' || op === '&') {
      // "| foo" with nothing before it is a syntax error; "(a) | b" links the
      // subshell's last segment to the next one.
      if (segments.length === 0) flags.parseError = true;
      else operators[operators.length - 1] = op;
    }
    words = [];
    redirects = [];
  };

  const consumeHeredocs = (from: number): number => {
    let i = from;
    while (pendingHeredocs.length) {
      const { delim, stripTabs } = pendingHeredocs.shift()!;
      const body: string[] = [];
      let found = false;
      while (i < input.length) {
        let end = input.indexOf('\n', i);
        if (end < 0) end = input.length;
        let line = input.slice(i, end);
        i = end + 1;
        if (stripTabs) line = line.replace(/^\t+/, '');
        if (line === delim) {
          found = true;
          break;
        }
        body.push(line);
      }
      heredocs.push(body.join('\n'));
      if (!found) flags.parseError = true;
    }
    return i;
  };

  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];

    if (c === '\\') {
      if (i + 1 < n) {
        if (input[i + 1] !== '\n') {
          cur += input[i + 1];
          inWord = true;
        }
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      inWord = true;
      if (end < 0) {
        flags.parseError = true;
        cur += input.slice(i + 1);
        i = n;
        break;
      }
      cur += input.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (c === '$' && input[i + 1] === "'") {
      // ANSI-C quoting: $'...'
      let j = i + 2;
      let s = '';
      while (j < n && input[j] !== "'") {
        if (input[j] === '\\' && j + 1 < n) {
          s += input[j + 1];
          j += 2;
        } else {
          s += input[j];
          j++;
        }
      }
      inWord = true;
      if (j >= n) {
        flags.parseError = true;
        cur += s;
        i = n;
        break;
      }
      cur += s;
      i = j + 1;
      continue;
    }

    if (c === '"') {
      inWord = true;
      i++;
      while (i < n && input[i] !== '"') {
        const d = input[i];
        if (d === '\\' && i + 1 < n && '"\\$`\n'.includes(input[i + 1])) {
          if (input[i + 1] !== '\n') cur += input[i + 1];
          i += 2;
          continue;
        }
        if (d === '$' && input[i + 1] === '(') {
          flags.substitution = true;
          const close = findClosingParen(input, i + 2);
          if (close < 0) {
            flags.parseError = true;
            i = n;
            break;
          }
          inner.push(input.slice(i + 2, close));
          cur += '$(…)';
          i = close + 1;
          continue;
        }
        if (d === '`') {
          flags.substitution = true;
          const close = findClosingBacktick(input, i + 1);
          if (close < 0) {
            flags.parseError = true;
            i = n;
            break;
          }
          inner.push(input.slice(i + 1, close));
          cur += '`…`';
          i = close + 1;
          continue;
        }
        if (d === '$' && VAR_START.test(input[i + 1] ?? '')) flags.variable = true;
        cur += d;
        i++;
      }
      if (i >= n) {
        flags.parseError = true; // unterminated double quote
        break;
      }
      i++; // closing quote
      continue;
    }

    if (c === '$' && input[i + 1] === '(') {
      flags.substitution = true;
      const close = findClosingParen(input, i + 2);
      if (close < 0) {
        flags.parseError = true;
        break;
      }
      inner.push(input.slice(i + 2, close));
      cur += '$(…)';
      inWord = true;
      i = close + 1;
      continue;
    }

    if (c === '`') {
      flags.substitution = true;
      const close = findClosingBacktick(input, i + 1);
      if (close < 0) {
        flags.parseError = true;
        break;
      }
      inner.push(input.slice(i + 1, close));
      cur += '`…`';
      inWord = true;
      i = close + 1;
      continue;
    }

    if (c === '$' && VAR_START.test(input[i + 1] ?? '')) {
      flags.variable = true;
      cur += c;
      inWord = true;
      i++;
      continue;
    }

    if (c === '#' && !inWord) {
      const nl = input.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }

    if (c === ' ' || c === '\t' || c === '\r') {
      pushWord();
      i++;
      continue;
    }

    if (c === '\n') {
      endSegment(';');
      i++;
      if (pendingHeredocs.length) i = consumeHeredocs(i);
      continue;
    }

    if (c === ';') {
      if (input[i + 1] === ';') {
        endSegment(';;');
        i += 2;
      } else {
        endSegment(';');
        i++;
      }
      continue;
    }

    if (c === '&') {
      if (input[i + 1] === '&') {
        endSegment('&&');
        i += 2;
        continue;
      }
      if (input[i + 1] === '>') {
        pushWord();
        const op = input[i + 2] === '>' ? '&>>' : '&>';
        pendingRedirect = { op, fd: '&' };
        i += op.length;
        continue;
      }
      flags.background = true;
      endSegment('&');
      i++;
      continue;
    }

    if (c === '|') {
      if (input[i + 1] === '|') {
        endSegment('||');
        i += 2;
      } else if (input[i + 1] === '&') {
        endSegment('|&');
        i += 2;
      } else {
        endSegment('|');
        i++;
      }
      continue;
    }

    if ((c === '<' || c === '>') && input[i + 1] === '(') {
      flags.processSubstitution = true;
      const close = findClosingParen(input, i + 2);
      if (close < 0) {
        flags.parseError = true;
        break;
      }
      inner.push(input.slice(i + 2, close));
      cur += c + '(…)';
      inWord = true;
      i = close + 1;
      continue;
    }

    if (c === '<' || c === '>') {
      let fd: string | undefined;
      if (inWord && /^\d+$/.test(cur)) {
        fd = cur;
        cur = '';
        inWord = false;
      } else {
        pushWord();
      }
      if (pendingRedirect) flags.parseError = true;
      let op: string = c;
      let j = i + 1;
      if (c === '>') {
        if (input[j] === '>') {
          op = '>>';
          j++;
        } else if (input[j] === '|') {
          op = '>|';
          j++;
        } else if (input[j] === '&') {
          op = '>&';
          j++;
        }
      } else if (input[j] === '<') {
        op = '<<';
        j++;
        if (input[j] === '<') {
          op = '<<<';
          j++;
        } else if (input[j] === '-') {
          op = '<<-';
          j++;
        }
      } else if (input[j] === '&') {
        op = '<&';
        j++;
      } else if (input[j] === '>') {
        op = '<>';
        j++;
      }
      if (op === '<<' || op === '<<-') flags.heredoc = true;
      pendingRedirect = { op, fd };
      i = j;
      continue;
    }

    if (c === '(' || c === ')') {
      flags.subshell = true;
      endSegment(c);
      i++;
      continue;
    }

    if ((c === '{' || c === '}') && !inWord) {
      const next = input[i + 1];
      if (next === undefined || next === ' ' || next === '\t' || next === '\n' || next === ';') {
        flags.group = true;
        endSegment(c);
        i++;
        continue;
      }
    }

    if (c === '*' || c === '?' || c === '[') flags.glob = true;
    cur += c;
    inWord = true;
    i++;
  }
  endSegment();
  if (pendingHeredocs.length) {
    // Heredoc started on the last line without a body.
    flags.parseError = true;
  }
  return { segments, operators, flags, inner, heredocs };
}

/** Collapses whitespace so allow/deny patterns compare predictably. */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

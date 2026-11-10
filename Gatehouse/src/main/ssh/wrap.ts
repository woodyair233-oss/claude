// POSIX command wrapping, shared by the exec channel and the WSL wrapper.

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs the command under bash when available so it is parsed the way
 * Gatehouse classified it, and reports the process-group id on stderr first
 * so a timed-out command can be killed even if the server ignores signals.
 */
export function wrapCommand(command: string): string {
  const q = shellQuote(command);
  const script = shellQuote(`printf '\\036GHPID:%s\\036' "$$" >&2; eval "$1"`);
  return `command -v bash >/dev/null 2>&1 && exec bash -c ${script} gatehouse ${q}; exec sh -c ${script} gatehouse ${q}`;
}

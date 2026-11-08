// English text for connection diagnostics. English is the translation key: the
// renderer passes these through t() (see lib/zh.ts), and the main process uses
// them as-is for the short summary Claude receives. Keep the {placeholders}
// identical in every translation.

import type { ConnCause, ConnParams, ConnStepCode } from './types';

export const CONN_CAUSE_TITLE: Record<ConnCause, string> = {
  dns: 'The server name could not be found',
  refused: 'The server refused the connection on port {port}',
  'tcp-timeout': 'The server did not answer',
  unreachable: 'The server\'s network cannot be reached',
  reset: 'The server closed the connection right away',
  'not-ssh': 'Port {port} is not an SSH service',
  'no-greeting': 'Port {port} answered, but no SSH server responded',
  'handshake-timeout': 'The server stopped responding while setting up the connection',
  algorithms: 'The server only supports outdated encryption',
  'algorithms-unsupported': 'Gatehouse and the server have no encryption method in common',
  'hostkey-rejected': 'The server identity was not accepted',
  'auth-password': 'The username or password was not accepted',
  'auth-key': 'The server did not accept this SSH key',
  'auth-agent': 'None of the SSH agent\'s keys were accepted',
  'auth-interactive': 'The server did not accept your answers',
  'auth-method': 'The server does not allow logging in with: {method}',
  'auth-partial': 'The server needs another login step',
  'agent-missing': 'No SSH agent is running',
  'key-missing': 'The selected SSH key is missing',
  'key-passphrase': 'The key passphrase was not correct',
  'vault-locked': 'Gatehouse is locked',
  cancelled: 'The connection was cancelled',
  jump: 'The jump host {jump} could not be connected',
  'jump-forward': 'The jump host could not reach this server',
  dropped: 'The connection was lost',
  unknown: 'The connection failed',
};

/** What to try, one suggestion per line. */
export const CONN_CAUSE_HINTS: Record<ConnCause, string> = {
  dns: 'Check the hostname for typos.\nIf the server is on a hospital, campus or company network, connect to its VPN first.\nTry the IP address instead of the name.',
  refused: 'The SSH service may not be running on the server. Ask the admin to start it (sshd).\nCheck the port: SSH normally uses 22.\nA firewall on the server may be rejecting connections.',
  'tcp-timeout': 'Check that the address is right and the server is switched on.\nIf the server is on an internal network, connect to the VPN first.\nA firewall may be silently blocking port {port}.',
  unreachable: 'Check your Wi-Fi or network cable, and whether you need a VPN.\nOn macOS, allow Gatehouse under System Settings → Privacy & Security → Local Network.\nCheck that the address is right.',
  reset: 'After too many failed logins, servers often block your address for a while (for example with fail2ban). Wait, or ask the admin.\nThe server may only accept connections from certain addresses or networks.\nCheck that port {port} really is the SSH port.',
  'not-ssh': 'The port is probably wrong: SSH normally uses 22.\nAsk the admin which port the SSH service uses.',
  'no-greeting': 'The port is probably wrong: another kind of service answered. SSH normally uses 22.\nThe server may be overloaded. Try again in a minute.\nA proxy or firewall may accept connections without passing them on.',
  'handshake-timeout': 'The server may be overloaded. Try again in a minute.\nA VPN or firewall may be interrupting the connection.',
  algorithms: 'Edit this host, open Advanced, turn on “Allow legacy algorithms”, then try again.\nBetter in the long run: ask the admin to update the server\'s SSH software.',
  'algorithms-unsupported': 'The server only offers methods Gatehouse cannot use, even with legacy algorithms turned on.\nAsk the admin to update the server\'s SSH software.',
  'hostkey-rejected': 'If you did not expect this, do not connect: the server may have been replaced. Ask the admin first.\nIf the server was reinstalled, connect again and accept the new identity.',
  'auth-password': 'Check the username and password. Watch out for Caps Lock and the input method.\nThe account may be locked or expired. Ask the admin.\nMany servers do not let “root” log in with a password.',
  'auth-key': 'Put this key on the server: in Keys, “Install on Host…” does it for you while you can still log in with a password.\nCheck the username: the key must be set up for this user.\nOn the server, ~/.ssh must have permissions 700 and authorized_keys 600.',
  'auth-agent': 'Check that the agent holds the right key: run “ssh-add -l” in Terminal.\nPut the matching public key in ~/.ssh/authorized_keys on the server.',
  'auth-interactive': 'Check what you typed. Verification codes expire quickly, so use a fresh one.\nAsk the admin whether your account needs a different login method.',
  'auth-method': 'The server accepts: {allowed}. Edit this host and change the login method under Authentication.\nTo log in with a key, create one under Keys and ask the admin to authorize it.',
  'auth-partial': 'The server requires more than one step (for example a key plus a verification code). Still needed: {allowed}.\nAsk the admin which login methods your account needs.',
  'agent-missing': 'Start your SSH agent (or the 1Password SSH agent), or edit this host to log in with a key or password instead.',
  'key-missing': 'Edit this host and choose a key again under Authentication.',
  'key-passphrase': 'Type the passphrase again. It is the one chosen when the key was created.',
  'vault-locked': 'Unlock Gatehouse, then try again.',
  cancelled: 'A password or confirmation window was closed before the connection was ready. Try again.',
  jump: 'Open the jump host\'s own connection log to see why it failed.\nCheck that the jump host can be connected on its own.',
  'jump-forward': 'This server\'s address and port are dialled from the jump host, not from your Mac. Check them.\nThe jump host may not allow tunnels (AllowTcpForwarding).',
  dropped: 'The network may have changed: Wi-Fi switched, the VPN reconnected, or the Mac went to sleep.\nThe server may have restarted, or closed a connection that looked idle. Try a shorter keep-alive under Advanced.',
  unknown: 'See the technical details below. Copy them and send them to your admin.',
};

export const CONN_STEP_TEXT: Record<ConnStepCode, string> = {
  prompt: 'Waited for your input',
  'dns-ok': 'Looked up {name}: {addresses}',
  'dns-fail': 'Could not look up {name} ({code})',
  'tcp-ok': 'Opened a network connection to {address} port {port} ({ms} ms)',
  'tcp-fail': 'Network connection to {address} port {port} failed ({code})',
  'tcp-timeout': 'No answer from {address} port {port} within {sec} s',
  'jump-ok': 'Connected to the jump host {jump}',
  'jump-fail': 'The jump host {jump} could not be connected',
  'tunnel-ok': 'The jump host opened a tunnel to port {port}',
  'tunnel-fail': 'The jump host could not open a tunnel to port {port}: {reason}',
  ident: 'Server software: {software}',
  'ident-timeout': 'No SSH greeting from the server within {sec} s',
  'probe-ssh': 'A second check received an SSH greeting: {software}',
  'probe-text': 'A second check found a different service on this port: “{banner}”',
  'probe-silent': 'A second check got no answer from this port',
  'probe-closed': 'A second check was also disconnected straight away',
  'kex-ok': 'Agreed on encryption: {kex} · {cipher}',
  'kex-fail': 'No {what} method in common. The server offers: {offered}',
  'hostkey-known': 'Server identity matches the saved fingerprint ({type})',
  'hostkey-system': 'Server identity matches ~/.ssh/known_hosts ({type})',
  'hostkey-new': 'You trusted the server identity {fingerprint}',
  'hostkey-changed': 'You accepted a changed server identity {fingerprint}',
  'hostkey-rejected': 'Server identity {fingerprint} was not accepted',
  'hostkey-revoked': 'The server key is marked as revoked in ~/.ssh/known_hosts',
  banner: 'Server message: “{text}”',
  'auth-try': 'Logging in as {user} with: {method}',
  'auth-fail': 'Rejected: {method}. The server accepts: {allowed}',
  'auth-partial': 'Accepted: {method}. The server also requires: {allowed}',
  'auth-exhausted': 'No other login method left to try',
  'auth-ok': 'Logged in with: {method}',
  ready: 'Connected ({ms} ms in total)',
  failed: 'Connection failed',
  closed: 'Connection closed',
  dropped: 'Connection lost: {reason}',
};

/** Why a live connection ended (the 'reason' of a 'dropped' step). */
export const CONN_DROP_TEXT: Record<string, string> = {
  closed: 'The server or the network closed the connection.',
  keepalive: 'The server stopped answering keep-alive checks.',
  reset: 'The connection was reset by the server or the network.',
  timeout: 'The network stopped responding.',
  unreachable: 'The network became unreachable.',
  other: 'An unexpected error ended the connection.',
};

/** Steps whose text names the server address or user (blurred in privacy mode, masked in copies). */
export const CONN_ADDRESS_STEPS: ReadonlySet<ConnStepCode> = new Set(['dns-ok', 'dns-fail', 'tcp-ok', 'tcp-fail', 'tcp-timeout', 'auth-try']);

/** Text for the 'prompt' step, by what was asked. */
export const CONN_PROMPT_TEXT: Record<string, string> = {
  password: 'Asked you for the password',
  passphrase: 'Asked you for the key passphrase',
  'host-key': 'Asked you to confirm the server identity',
  'keyboard-interactive': 'The server asked you: {prompts}',
};

/** SSH login method names as the protocol spells them. */
export const AUTH_METHOD_LABEL: Record<string, string> = {
  password: 'Password',
  publickey: 'SSH key',
  agent: 'SSH agent',
  'keyboard-interactive': 'Keyboard-interactive',
  hostbased: 'Host-based',
  'gssapi-with-mic': 'Kerberos (GSSAPI)',
  'gssapi-keyex': 'Kerberos (GSSAPI)',
  none: 'None',
};

/** Kinds of algorithm in the SSH handshake. */
export const ALGO_KIND_LABEL: Record<string, string> = {
  kex: 'key exchange',
  hostKey: 'host key',
  cipher: 'cipher',
  mac: 'MAC',
  compression: 'compression',
};

/** Fills {placeholders}; unknown ones are left as they are. */
export function fillTemplate(template: string, params?: ConnParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m));
}

/** The English one-line summary of a failure (what Claude and the logs see). */
export function connCauseMessage(cause: ConnCause, params?: ConnParams): string {
  return fillTemplate(CONN_CAUSE_TITLE[cause], params);
}

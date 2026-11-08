// End-to-end UI run: launches the real Electron app (under Xvfb on Linux),
// drives the main flows, exercises the MCP gateway through the real bridge,
// asserts outcomes and saves screenshots.
//
//   xvfb-run -a node tests/e2e/ui.cjs [outDir]
const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron } = require('playwright');
const { startSshd, startAgent, seedHome } = require('./env.cjs');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'test-results/shots'));
const BRIDGE = path.join(ROOT, 'build/bin/linux-x64/gatehouse-mcp');
const errors = [];
const results = [];

function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function shot(win, name) {
  await win.waitForTimeout(350);
  await win.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function nav(win, label) {
  await win.locator('.sidebar .nav-item', { hasText: label }).first().click();
  await win.waitForTimeout(250);
}

async function mcpClient(home) {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const transport = new StdioClientTransport({ command: BRIDGE, args: ['--no-launch'], env: { GATEHOUSE_HOME: home, PATH: process.env.PATH }, stderr: 'pipe' });
  const client = new Client({ name: 'claude-code', version: '2.1.0' });
  await client.connect(transport);
  return client;
}

const text = (r) => (r.content || []).map((c) => c.text || '').join('\n');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sshd = await startSshd();
  const agent = startAgent(sshd.clientKey);
  const { home } = seedHome(sshd);
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT, '--no-sandbox', '--force-device-scale-factor=1'],
    cwd: ROOT,
    env: { ...process.env, GATEHOUSE_HOME: home, SSH_AUTH_SOCK: agent.sock, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', LANG: 'en_US.UTF-8' },
  });
  try {
    const win = await app.firstWindow();
    win.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1360, 880);
      w.center();
    });
    await win.waitForSelector('.sidebar', { timeout: 20000 });
    await win.waitForSelector('.host-card');
    check('app boots and shows hosts', (await win.locator('.host-card').count()) === 5);
    await shot(win, '01-hosts');

    // Host editor (AI tab)
    await win.locator('.host-card', { hasText: 'Lab GPU server' }).getByRole('button', { name: 'Edit' }).click();
    await win.waitForSelector('.sheet');
    await shot(win, '02-host-editor-general');
    await win.locator('.tabs button', { hasText: 'AI Access' }).click();
    await shot(win, '03-host-editor-ai');
    await win.keyboard.press('Escape');

    // Terminal
    await win.locator('.host-card', { hasText: 'Lab GPU server' }).getByRole('button', { name: 'Connect' }).click();
    await win.waitForSelector('.term-tab');
    await win.waitForFunction(() => !document.querySelector('.term-overlay'), null, { timeout: 20000 });
    await win.waitForTimeout(800);
    await win.locator('.term-pane.active .xterm').click();
    await win.keyboard.type("printf '\\033[1;34mGatehouse terminal\\033[0m on %s\\n' \"$(uname -sr)\"; ls -la --color=always ~/projects/pacs-bridge; tail -n 4 ~/logs/bridge.log\n");
    await win.waitForTimeout(1500);
    const termText = await win.locator('.term-pane.active .xterm-rows, .term-pane.active canvas').count();
    check('terminal opened and connected', termText > 0);
    await shot(win, '04-terminal');

    // Files
    await nav(win, 'Files');
    await win.waitForSelector('.files-table, .qc-item');
    if (await win.locator('.qc-item').count()) await win.locator('.qc-item', { hasText: 'Lab GPU server' }).click();
    await win.waitForSelector('.files-table tbody tr');
    await win.locator('.files-table tbody tr', { hasText: 'projects' }).dblclick();
    await win.waitForTimeout(500);
    await win.locator('.files-table tbody tr', { hasText: 'pacs-bridge' }).dblclick();
    await win.waitForTimeout(600);
    check('sftp browsing works', (await win.locator('.files-table tbody tr', { hasText: 'compose.yml' }).count()) === 1);
    await shot(win, '05-files');
    await win.locator('.files-table tbody tr', { hasText: 'compose.yml' }).dblclick();
    await win.waitForSelector('.editor-area');
    await shot(win, '06-file-editor');
    await win.keyboard.press('Escape');

    // Tunnels
    await nav(win, 'Tunnels');
    await win.locator('.tunnel-card', { hasText: 'Grafana dashboard' }).locator('.switch').click();
    await win.waitForSelector('.tunnel-card.running', { timeout: 15000 });
    check('tunnel starts', true);
    await shot(win, '07-tunnels');

    // Keys: generate one
    await nav(win, 'Keys');
    await win.getByRole('button', { name: 'Generate Key' }).first().click();
    await win.locator('.modal input').first().fill('Lab servers');
    await win.locator('.modal').getByRole('button', { name: 'Generate' }).click();
    await win.waitForSelector('.key-row');
    check('key generation works', (await win.locator('.key-row').count()) === 1);
    await shot(win, '08-keys');

    await nav(win, 'Snippets');
    await shot(win, '09-snippets');

    // ---------------------------------------------------------------- MCP
    const client = await mcpClient(home);
    const tools = await client.listTools();
    check('bridge lists 8 tools', tools.tools.length === 8);
    const hostsList = text(await client.callTool({ name: 'list_hosts', arguments: {} }));
    check('AI sees aliases only', hostsList.includes('lab-gpu') && !hostsList.includes('127.0.0.1') && !hostsList.includes('backup-nas'));
    const auto = text(await client.callTool({ name: 'run_command', arguments: { host: 'lab-gpu', command: 'hostname -I; tail -n 3 ~/logs/bridge.log', reason: 'Check recent DICOM traffic' } }));
    check('read-only command auto-approved and redacted', auto.includes('auto-approved') && auto.includes('[ip-'), auto.split('\n')[0]);
    await client.callTool({ name: 'get_host_info', arguments: { host: 'lab-gpu' } });
    await client.callTool({ name: 'run_command', arguments: { host: 'pacs-gw', command: 'rm -rf /' } }).catch(() => undefined);

    // Approval flow through the UI
    await nav(win, 'Hosts');
    const pendingCall = client.callTool({ name: 'run_command', arguments: { host: 'lab-gpu', command: 'docker compose -f ~/projects/pacs-bridge/compose.yml restart bridge', reason: 'The bridge stopped forwarding studies after the config change; restarting it should reload bridge.yml.' } });
    await win.waitForSelector('.approval-modal', { timeout: 10000 });
    await shot(win, '10-approval-modal');
    await win.locator('.approval-modal').getByRole('button', { name: /Allow once/ }).click();
    const approved = text(await pendingCall);
    check('approval through UI runs the command', approved.includes('approved by the user'), approved.split('\n')[0]);

    const denyCall = client.callTool({ name: 'run_command', arguments: { host: 'lab-gpu', command: 'sudo systemctl restart ssh', reason: 'Apply the new sshd settings' } });
    await win.waitForSelector('.approval-modal', { timeout: 10000 });
    await shot(win, '11-approval-danger');
    await win.locator('.approval-modal').getByRole('button', { name: /Deny with note/ }).click();
    await win.locator('.approval-modal textarea').fill('Never restart sshd remotely — ask me to do it on the console.');
    await win.locator('.approval-modal').getByRole('button', { name: /Deny and send note/ }).click();
    const denied = await denyCall;
    check('denial note reaches the AI', denied.isError && text(denied).includes('Never restart sshd'));

    const writeCall = client.callTool({ name: 'write_file', arguments: { host: 'lab-gpu', path: '/home/ghtest/projects/pacs-bridge/config/bridge.yml', content: 'listen: 0.0.0.0:104\narchive: [ip-1]:11112\nae_title: GATEHOUSE\nretry: 3\n', reason: 'Fix the AE title typo and add retries' } });
    await win.waitForSelector('.approval-modal', { timeout: 10000 });
    await shot(win, '12-approval-write');
    await win.locator('.approval-modal').getByRole('button', { name: /Allow once/ }).click();
    check('file write approved', text(await writeCall).includes('wrote'));

    // ---------------------------------------------------------------- connection diagnostics
    const closedPort = await new Promise((resolve) => {
      const srv = require('node:net').createServer();
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
    });
    await nav(win, 'Hosts');
    await win.getByRole('button', { name: 'New Host' }).first().click();
    await win.waitForSelector('.sheet');
    const fieldIn = (label) => win.locator('.sheet .field').filter({ has: win.locator('label', { hasText: label }) }).locator('input').first();
    await fieldIn('Display name').fill('Old archive');
    await fieldIn('Hostname or IP').fill('127.0.0.1');
    await fieldIn('Port').fill(String(closedPort));
    await fieldIn('Username').fill('ghtest');
    await fieldIn('Alias').fill('old-archive');
    await win.locator('.sheet .tabs button', { hasText: 'Authentication' }).click();
    await win.locator('.sheet .seg button', { hasText: 'SSH agent' }).click();
    await win.locator('.sheet').getByRole('button', { name: 'Save & Test' }).click();
    await win.waitForSelector('.connlog-modal .cl-verdict.red', { timeout: 30000 });
    const verdict = (await win.locator('.connlog-modal .cl-verdict-title').textContent()) ?? '';
    check('failed Save & Test opens the connection log', /refused the connection on port/.test(verdict), verdict);
    await shot(win, '26-connection-log');
    await win.keyboard.press('Escape');
    await win.waitForSelector('.connlog-modal', { state: 'detached' });
    await win.keyboard.press('Escape');
    await win.waitForSelector('.host-card .conn-problem', { timeout: 10000 });
    check('host card flags the failed connection', (await win.locator('.host-card', { hasText: 'Old archive' }).locator('.conn-problem').count()) === 1);
    const aiFail = await client.callTool({ name: 'run_command', arguments: { host: 'old-archive', command: 'uptime' } });
    const aiText = text(aiFail);
    check('Claude is told why, without the address', aiFail.isError && /refused the connection on port/.test(aiText) && aiText.includes('connection log') && !aiText.includes('127.0.0.1'), aiText);
    await nav(win, 'Files');
    await win.locator('.toolbar select').selectOption({ label: 'Old archive' });
    await win.waitForSelector('.empty h2:has-text("Could not connect to Old archive")', { timeout: 30000 });
    const filesBody = (await win.locator('.empty p').first().textContent()) ?? '';
    check('Files view explains a failed connection', /refused the connection on port/.test(filesBody) && (await win.locator('.empty').getByRole('button', { name: 'View details' }).count()) === 1, filesBody);
    await win.locator('.toolbar select').selectOption({ label: 'Lab GPU server' });

    await nav(win, 'Overview');
    await win.waitForTimeout(400);
    await shot(win, '13-gateway');
    await win.locator('.content').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await shot(win, '14-gateway-setup');

    await nav(win, 'Activity');
    await shot(win, '15-activity');
    await win.locator('.activity-row').first().click();
    await win.waitForSelector('.sheet');
    await shot(win, '16-activity-detail');
    await win.keyboard.press('Escape');

    await nav(win, 'Approvals');
    await shot(win, '17-approvals-empty');
    await nav(win, 'Policies');
    await shot(win, '18-policies');
    await win.locator('.content').evaluate((el) => el.scrollTo(0, 1500));
    await shot(win, '19-policies-redaction');
    await nav(win, 'Audit Log');
    await win.waitForSelector('.integrity.ok', { timeout: 10000 });
    check('audit chain verifies in UI', true);
    await shot(win, '20-audit');

    await nav(win, 'Settings');
    await shot(win, '21-settings-general');
    await win.locator('.settings-nav button', { hasText: 'Terminal' }).click();
    await shot(win, '22-settings-terminal');
    await win.locator('.settings-nav button', { hasText: 'Security' }).click();
    await shot(win, '23-settings-security');

    // Command palette
    await win.locator('.sidebar-search').click();
    await win.keyboard.type('lab');
    await shot(win, '24-palette');
    await win.keyboard.press('Escape');

    // Kill switch
    await win.locator('.kill-switch .switch').click();
    await win.waitForSelector('.kill-switch.paused');
    const paused = await client.callTool({ name: 'list_hosts', arguments: {} });
    check('kill switch refuses AI requests', paused.isError && text(paused).includes('paused'));
    await nav(win, 'Overview');
    await shot(win, '25-gateway-paused');
    await win.locator('.kill-switch .switch').click();
    // Wait for AI access to actually resume before relying on an approval below.
    await win.waitForSelector('.kill-switch.paused', { state: 'detached' });

    // Dark mode
    await win.evaluate(() => window.gatehouse.settings.update({ theme: 'dark' }));
    await win.waitForTimeout(600);
    await nav(win, 'Hosts');
    await shot(win, '30-dark-hosts');
    await nav(win, 'Overview');
    await shot(win, '31-dark-gateway');
    await nav(win, 'Terminals');
    await shot(win, '32-dark-terminal');
    const darkPending = client.callTool({ name: 'run_command', arguments: { host: 'prod-web', command: 'git -C /srv/site reset --hard origin/main', reason: 'Discard the hotfix and redeploy main' } });
    // The modal must appear (danger command on a trusted host); fail loudly if not,
    // so the screenshot never silently captures the view underneath.
    await win.waitForSelector('.approval-modal.is-danger, .approval-modal:has(.is-danger)', { timeout: 15000 });
    await win.waitForTimeout(150);
    await shot(win, '33-dark-approval');
    check('dark high-risk approval modal shown', await win.locator('.approval-modal').count() > 0);
    await win.locator('.approval-modal').getByRole('button', { name: /^Deny$/ }).click();
    await darkPending.catch(() => undefined);
    await nav(win, 'Activity');
    await shot(win, '34-dark-activity');

    // Chinese UI
    await win.evaluate(() => window.gatehouse.settings.update({ language: 'zh-Hans', theme: 'light' }));
    await win.waitForTimeout(700);
    await win.locator('.sidebar .nav-item').first().click();
    await shot(win, '40-zh-hosts');
    await win.locator('.sidebar .nav-item.ai').first().click();
    await shot(win, '41-zh-gateway');
    await win.evaluate(() => window.gatehouse.settings.update({ language: 'en' }));

    await client.close();
  } catch (err) {
    console.error('✗ step failed:', err.message.split('\n').slice(0, 6).join('\n'));
    await (await app.firstWindow()).screenshot({ path: path.join(OUT, 'zz-failure.png') }).catch(() => undefined);
    results.push({ name: 'flow completed', ok: false, detail: err.message.split('\n')[0] });
  } finally {
    await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
    agent.stop();
    sshd.child.kill();
  }
  const ignorable = (e) => /DevTools|Autofill|ERR_FILE_NOT_FOUND.*map/.test(e);
  const real = errors.filter((e) => !ignorable(e));
  check('no renderer errors', real.length === 0, real.slice(0, 5).join(' | '));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

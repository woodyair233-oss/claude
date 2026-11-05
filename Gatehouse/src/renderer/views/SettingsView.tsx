import { useState } from 'react';
import { Database, Fingerprint, FolderOpen, Info, KeyRound, Lock, Palette, ShieldCheck, SquareTerminal, Upload } from 'lucide-react';
import type { AccentColor, LanguagePref, Settings, ThemePref } from '@shared/types';
import { api, attempt, useApp } from '../lib/store';
import { t } from '../lib/i18n';
import { ACCENTS, TERMINAL_THEMES, terminalTheme } from '../lib/themes';
import { Toolbar } from '../components/Toolbar';
import { Button, Card, Callout, Segmented, Select, SettingRow, Switch } from '../components/ui';
import { Logo } from '../components/domain';
import { promptDialog } from '../components/overlays';

type Tab = 'general' | 'terminal' | 'security' | 'data' | 'about';

function useUpdate() {
  return (patch: Record<string, unknown>) => void attempt(() => api().settings.update(patch), t('Could not save settings'));
}

function General({ s }: { s: Settings }) {
  const update = useUpdate();
  return (
    <>
      <Card>
        <SettingRow title={t('Language')}>
          <Select<LanguagePref> value={s.language} onChange={(v) => update({ language: v })} options={[{ value: 'system', label: t('System default') }, { value: 'en', label: 'English' }, { value: 'zh-Hans', label: '简体中文' }]} />
        </SettingRow>
        <SettingRow title={t('Appearance')}>
          <Segmented<ThemePref> value={s.theme} onChange={(v) => update({ theme: v })} options={[{ value: 'system', label: t('Auto') }, { value: 'light', label: t('Light') }, { value: 'dark', label: t('Dark') }]} />
        </SettingRow>
        <SettingRow title={t('Accent color')}>
          <div className="swatches">
            {(Object.keys(ACCENTS) as AccentColor[]).map((a) => (
              <button key={a} className={`swatch ${s.accent === a ? 'on' : ''}`} style={{ background: ACCENTS[a].light }} onClick={() => update({ accent: a })} aria-label={a} title={a} />
            ))}
          </div>
        </SettingRow>
      </Card>
      <Card style={{ marginTop: 14 }}>
        <SettingRow title={t('Open at login')} desc={t('Keeps the AI gateway available whenever you are signed in.')}>
          <Switch on={s.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
        </SettingRow>
        <SettingRow title={t('Show in menu bar')} desc={t('Pending approvals and the pause switch, one click away.')}>
          <Switch on={s.showInMenuBar} onChange={(v) => update({ showInMenuBar: v })} />
        </SettingRow>
        <SettingRow title={t('Privacy mode')} desc={t('Blur hostnames and addresses in the interface (handy when screen sharing). Hover to reveal.')}>
          <Switch on={s.privacyMode} onChange={(v) => update({ privacyMode: v })} />
        </SettingRow>
        <SettingRow title={t('Confirm before quitting')} desc={t('Asks when terminals are open or AI clients are connected.')}>
          <Switch on={s.confirmOnQuit} onChange={(v) => update({ confirmOnQuit: v })} />
        </SettingRow>
      </Card>
    </>
  );
}

function TerminalTab({ s }: { s: Settings }) {
  const update = useUpdate();
  const term = s.terminal;
  const setTerm = (patch: Partial<Settings['terminal']>) => update({ terminal: patch });
  return (
    <>
      <div className="theme-grid">
        {[{ id: 'auto', name: t('Match appearance') }, ...TERMINAL_THEMES].map((th) => {
          const def = terminalTheme(th.id).theme;
          return (
            <button key={th.id} className={`theme-swatch ${term.theme === th.id ? 'on' : ''}`} onClick={() => setTerm({ theme: th.id })}>
              <div className="ts-preview" style={{ background: def.background, color: def.foreground }}>
                <span style={{ color: def.green }}>❯</span> <span style={{ color: def.blue }}>~/app</span> <span style={{ color: def.yellow }}>git:(main)</span>
                <br />
                <span style={{ color: def.magenta }}>ls</span> -la <span style={{ color: def.red }}>●</span><span style={{ color: def.cyan }}>●</span>
              </div>
              <div className="ts-name">{th.name}</div>
            </button>
          );
        })}
      </div>
      <Card style={{ marginTop: 14 }}>
        <SettingRow title={t('Font')}>
          <Select value={term.fontFamily} onChange={(v) => setTerm({ fontFamily: v })} options={['JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Courier New'].map((f) => ({ value: f, label: f }))} />
        </SettingRow>
        <SettingRow title={t('Font size')}>
          <Segmented value={String(term.fontSize)} onChange={(v) => setTerm({ fontSize: Number(v) })} options={['11', '12', '13', '14', '15', '16', '18'].map((n) => ({ value: n, label: n }))} />
        </SettingRow>
        <SettingRow title={t('Line height')}>
          <Segmented value={String(term.lineHeight)} onChange={(v) => setTerm({ lineHeight: Number(v) })} options={['1', '1.15', '1.25', '1.4'].map((n) => ({ value: n, label: n }))} />
        </SettingRow>
        <SettingRow title={t('Cursor')}>
          <Segmented value={term.cursorStyle} onChange={(v) => setTerm({ cursorStyle: v })} options={[{ value: 'bar', label: t('Bar') }, { value: 'block', label: t('Block') }, { value: 'underline', label: t('Underline') }]} />
          <Switch on={term.cursorBlink} onChange={(v) => setTerm({ cursorBlink: v })} label={t('Blink')} />
        </SettingRow>
        <SettingRow title={t('Scrollback')} desc={t('Lines kept per terminal.')}>
          <Select value={String(term.scrollback)} onChange={(v) => setTerm({ scrollback: Number(v) })} options={['2000', '10000', '50000', '100000'].map((n) => ({ value: n, label: Number(n).toLocaleString() }))} />
        </SettingRow>
        <SettingRow title={t('Copy on select')}>
          <Switch on={term.copyOnSelect} onChange={(v) => setTerm({ copyOnSelect: v })} />
        </SettingRow>
        <SettingRow title={t('Use Option as Meta key')} desc={t('For Emacs and readline shortcuts like Option-B / Option-F.')}>
          <Switch on={term.optionIsMeta} onChange={(v) => setTerm({ optionIsMeta: v })} />
        </SettingRow>
        <SettingRow title={t('Visual bell')}>
          <Switch on={term.bell} onChange={(v) => setTerm({ bell: v })} />
        </SettingRow>
      </Card>
    </>
  );
}

function Security({ s }: { s: Settings }) {
  const update = useUpdate();
  const snap = useApp((x) => x.snap!);
  const toast = useApp((x) => x.toast);
  const vault = snap.vault;
  const canLock = snap.touchIdAvailable || vault.passwordWrap;
  const [busy, setBusy] = useState(false);

  const setPassword = async () => {
    let current: string | null = null;
    if (vault.passwordWrap) {
      current = await promptDialog({ title: t('Current master password'), password: true });
      if (current === null) return;
    }
    const next = await promptDialog({ title: vault.passwordWrap ? t('New master password') : t('Set a master password'), message: t('At least 8 characters. It unlocks the vault if the Keychain is unavailable — Gatehouse cannot recover it for you.'), password: true });
    if (!next) return;
    const again = await promptDialog({ title: t('Repeat the master password'), password: true });
    if (again !== next) return toast({ kind: 'error', title: t('The passwords do not match') });
    setBusy(true);
    const ok = await attempt(() => api().vault.setPassword(current, next), t('Could not set the master password'));
    setBusy(false);
    if (ok !== undefined) toast({ kind: 'success', title: t('Master password saved') });
  };

  return (
    <>
      <Card>
        <div className="card-section vault-status">
          <div className="vs-icon"><ShieldCheck size={20} /></div>
          <div className="grow">
            <strong>{t('Encrypted vault')}</strong>
            <div className="faint" style={{ fontSize: 12 }}>
              {t('Passwords and private keys are sealed with AES-256-GCM. The vault key is protected by:')}
            </div>
            <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              {vault.keychainWrap && <span className="badge green"><KeyRound size={10} />{vault.backend === 'keychain' ? t('macOS Keychain') : vault.backend === 'basic' ? t('Basic obfuscation (no keyring)') : t('System keyring')}</span>}
              {vault.passwordWrap && <span className="badge blue"><Lock size={10} />{t('Master password')}</span>}
            </div>
          </div>
        </div>
        {vault.backend === 'basic' && (
          <div className="card-section"><Callout tone="amber" icon={<Info size={15} />}>{t('No system keyring was found. Set a master password and turn off the keyring wrap for real protection.')}</Callout></div>
        )}
        <SettingRow title={t('Master password')} desc={vault.passwordWrap ? t('Set — can unlock the vault and the lock screen.') : t('Optional recovery path and lock-screen password.')}>
          <Button size="sm" loading={busy} onClick={() => void setPassword()}>{vault.passwordWrap ? t('Change…') : t('Set…')}</Button>
        </SettingRow>
        {vault.backend !== 'unavailable' && (
          <SettingRow title={t('Unlock with the Keychain automatically')} desc={t('Turn off to require the master password every time Gatehouse starts.')}>
            <Switch on={vault.keychainWrap} disabled={!vault.passwordWrap && vault.keychainWrap} onChange={(v) => void attempt(() => api().vault.setKeychain(v), t('Could not change the vault'))} />
          </SettingRow>
        )}
      </Card>
      <Card style={{ marginTop: 14 }}>
        <SettingRow title={<span className="row" style={{ gap: 6 }}><Fingerprint size={14} />{t('Lock when Gatehouse starts')}</span>} desc={canLock ? t('Unlock with Touch ID or your master password.') : t('Needs Touch ID or a master password.')}>
          <Switch on={s.security.lockOnLaunch} disabled={!canLock} onChange={(v) => update({ security: { lockOnLaunch: v } })} />
        </SettingRow>
        <SettingRow title={t('Auto-lock after inactivity')} desc={t('Also locks when the screen locks. The AI gateway keeps enforcing policy while locked; approvals wait until you unlock.')}>
          <Select value={String(s.security.autoLockMinutes)} disabled={!canLock} onChange={(v) => update({ security: { autoLockMinutes: Number(v) } })} options={[{ value: '0', label: t('Never') }, ...['5', '15', '30', '60'].map((m) => ({ value: m, label: t('{n} minutes', { n: m }) }))]} />
        </SettingRow>
        <SettingRow title={t('Touch ID for high-risk approvals')} desc={snap.touchIdAvailable ? t('Requires a fingerprint to approve high-risk commands.') : t('Touch ID is not available; you will type the host alias instead.')}>
          <Switch on={s.security.touchIdForDangerous} onChange={(v) => update({ security: { touchIdForDangerous: v } })} />
        </SettingRow>
        <SettingRow title={t('Lock now')}>
          <Button size="sm" icon={<Lock size={13} />} disabled={!canLock} onClick={() => void api().app.lock()}>{t('Lock')}</Button>
        </SettingRow>
      </Card>
    </>
  );
}

function Data() {
  const toast = useApp((s) => s.toast);
  const exportBackup = async () => {
    const pw = await promptDialog({ title: t('Backup password'), message: t('The backup includes saved passwords and private keys, encrypted with this password.'), password: true });
    if (!pw) return;
    const path = await attempt(() => api().app.exportBackup(pw), t('Backup failed'));
    if (path) toast({ kind: 'success', title: t('Backup saved'), message: path });
  };
  const importBackup = async () => {
    const pw = await promptDialog({ title: t('Backup password'), password: true });
    if (!pw) return;
    const r = await attempt(() => api().app.importBackup(pw), t('Restore failed'));
    if (r) toast({ kind: r.ok ? 'success' : 'info', title: r.message });
  };
  return (
    <Card>
      <SettingRow title={t('Export encrypted backup')} desc={t('Hosts, keys, tunnels, snippets, policies and saved secrets in one password-protected file.')}>
        <Button size="sm" icon={<Database size={13} />} onClick={() => void exportBackup()}>{t('Export…')}</Button>
      </SettingRow>
      <SettingRow title={t('Restore from backup')} desc={t('Replaces your current hosts and settings.')}>
        <Button size="sm" icon={<Upload size={13} />} onClick={() => void importBackup()}>{t('Restore…')}</Button>
      </SettingRow>
      <SettingRow title={t('Data folder')} desc="~/Library/Application Support/Gatehouse">
        <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void api().app.showDataFolder()}>{t('Show in Finder')}</Button>
      </SettingRow>
    </Card>
  );
}

function About() {
  const snap = useApp((s) => s.snap!);
  return (
    <Card>
      <div className="about">
        <Logo size={64} />
        <h2>Gatehouse</h2>
        <div className="faint">{t('Version {v}', { v: snap.appVersion })}</div>
        <p>{t('An SSH client and security gateway: Claude reaches your servers only through tools you control, with approvals, redaction and a tamper-evident audit log.')}</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button size="sm" onClick={() => void api().app.openExternal('https://github.com/woodyair233-oss/claude/tree/main/Gatehouse')}>{t('Project page')}</Button>
        </div>
        <div className="faint" style={{ fontSize: 11.5, marginTop: 14 }}>
          {t('Built with Electron, React, ssh2, xterm.js and the Model Context Protocol SDK. Fonts: JetBrains Mono and Inter (SIL OFL).')}
        </div>
        <div className="mono faint selectable" style={{ fontSize: 11, marginTop: 8 }}>{snap.gateway.bridgePath}</div>
      </div>
    </Card>
  );
}

export function SettingsView() {
  const s = useApp((x) => x.snap!.settings);
  const tab = useApp((x) => x.settingsTab) as Tab;
  const setTab = useApp((x) => x.setSettingsTab);
  const items: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: t('General'), icon: <Palette size={15} /> },
    { id: 'terminal', label: t('Terminal'), icon: <SquareTerminal size={15} /> },
    { id: 'security', label: t('Security'), icon: <ShieldCheck size={15} /> },
    { id: 'data', label: t('Data'), icon: <Database size={15} /> },
    { id: 'about', label: t('About'), icon: <Info size={15} /> },
  ];
  return (
    <>
      <Toolbar title={t('Settings')} />
      <div className="content">
        <div className="settings-layout">
          <nav className="settings-nav">
            {items.map((it) => (
              <button key={it.id} className={`nav-item ${tab === it.id ? 'active' : ''}`} onClick={() => setTab(it.id)}>
                {it.icon}
                {it.label}
              </button>
            ))}
          </nav>
          <div className="settings-body">
            <h2 className="settings-h">{items.find((i) => i.id === tab)?.label}</h2>
            {tab === 'general' && <General s={s} />}
            {tab === 'terminal' && <TerminalTab s={s} />}
            {tab === 'security' && <Security s={s} />}
            {tab === 'data' && <Data />}
            {tab === 'about' && <About />}
          </div>
        </div>
      </div>
    </>
  );
}

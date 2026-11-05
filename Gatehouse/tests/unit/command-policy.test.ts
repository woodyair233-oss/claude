import { describe, expect, it } from 'vitest';
import {
  assessCommand,
  commandParts,
  isSensitivePath,
  isSystemPath,
  matchCommandPattern,
} from '../../src/shared/command-policy';
import { parseShell } from '../../src/shared/shell-parse';

const risk = (cmd: string) => assessCommand(cmd).risk;
const codes = (cmd: string) => assessCommand(cmd).reasons.map((r) => r.code);

describe('shell lexer', () => {
  it('splits pipelines and lists', () => {
    const p = parseShell('ps aux | grep nginx && echo ok; ls -la');
    expect(p.segments.map((s) => s.words[0])).toEqual(['ps', 'grep', 'echo', 'ls']);
    expect(p.operators.slice(0, 3)).toEqual(['|', '&&', ';']);
  });
  it('keeps quoted operators inside words', () => {
    const p = parseShell(`grep "a|b; c" file 'x && y'`);
    expect(p.segments).toHaveLength(1);
    expect(p.segments[0].words).toEqual(['grep', 'a|b; c', 'file', 'x && y']);
  });
  it('records redirects with fds', () => {
    const p = parseShell('cmd 2>/dev/null >out.txt 2>&1');
    expect(p.segments[0].redirects).toEqual([
      { op: '>', fd: '2', target: '/dev/null' },
      { op: '>', fd: undefined, target: 'out.txt' },
      { op: '>&', fd: '2', target: '1' },
    ]);
  });
  it('extracts substitutions, even inside double quotes', () => {
    const p = parseShell('echo "user: $(whoami)" `date` <(ls)');
    expect(p.inner).toEqual(['whoami', 'date', 'ls']);
    expect(p.flags.substitution).toBe(true);
    expect(p.flags.processSubstitution).toBe(true);
  });
  it('skips heredoc bodies', () => {
    const p = parseShell("cat > /tmp/x <<'EOF'\nrm -rf /\nEOF\necho done");
    expect(p.heredocs).toEqual(['rm -rf /']);
    expect(p.segments.map((s) => s.words[0])).toEqual(['cat', 'echo']);
  });
  it('flags unterminated quotes', () => {
    expect(parseShell(`echo "oops`).flags.parseError).toBe(true);
    expect(parseShell(`echo 'oops`).flags.parseError).toBe(true);
  });
});

describe('read-only allowlist', () => {
  const readOnly = [
    'ls -la /var/log',
    'cat /etc/os-release',
    'df -h',
    'free -m',
    'uptime',
    'uname -a',
    'ps aux | grep -i nginx | head -20',
    'tail -n 200 /var/log/syslog',
    'journalctl -u nginx --since "1 hour ago" --no-pager',
    'systemctl status nginx',
    'systemctl list-units --failed',
    'systemctl --failed',
    'docker ps -a',
    'docker logs --tail 100 web',
    'docker compose -f prod.yml ps',
    'kubectl get pods -n kube-system -o wide',
    'kubectl logs deploy/api -n prod --tail=50',
    'git status',
    'git log --oneline -20',
    'git -C /srv/app diff HEAD~1',
    'git branch -a',
    'git branch --list "feat/*"',
    'git tag',
    'git remote -v',
    'find /var/log -name "*.log" -mtime -1',
    "sed -n '10,20p' /etc/nginx/nginx.conf",
    "sed 's/foo/bar/g' notes.txt",
    "awk -F: '{print $1}' /etc/passwd",
    'grep -rn "error" /var/log/nginx 2>/dev/null',
    'du -sh /var/* 2>/dev/null | sort -h | tail',
    'ip addr show',
    'ip -br a',
    'ip route get 1.1.1.1',
    'ss -tlnp',
    'netstat -tulpn',
    'nvidia-smi',
    'nvidia-smi --query-gpu=name,memory.used --format=csv',
    'top -bn1 | head -15',
    'cat /proc/cpuinfo',
    'lsblk -f',
    'apt list --installed',
    'dpkg -l | grep nginx',
    'crontab -l',
    'date +%F',
    'hostname -I',
    'LANG=C ls',
    'for f in *.log; do wc -l "$f"; done',
    'echo hello > /dev/null',
    'tar -tzf backup.tar.gz',
    'unzip -l archive.zip',
    'python3 --version',
    'iptables -L -n',
    'iptables -nvL',
    'nft list ruleset',
    'ufw status verbose',
    'sysctl -a',
    'test -f /etc/hosts && echo yes',
    'cd /var/log && ls',
    'jq .version package.json',
    'command -v docker',
  ];
  for (const cmd of readOnly) {
    it(`treats as read-only: ${cmd}`, () => {
      const a = assessCommand(cmd);
      expect(a.reasons, JSON.stringify(a.reasons)).toEqual([]);
      expect(a.risk).toBe('read');
    });
  }
});

describe('non read-only commands need approval', () => {
  const writes: [string, string][] = [
    ['touch /tmp/x', 'unknown-program'],
    ['echo hi > notes.txt', 'redirect-write'],
    ['echo hi >> notes.txt', 'redirect-write'],
    ['ls | tee out.txt', 'unknown-program'],
    ["sed -i 's/a/b/' file", 'modifying-args'],
    ["sed -ni 's/a/b/p' file", 'modifying-args'],
    ["sed -i.bak 's/a/b/' file", 'modifying-args'],
    ["sed 's/a/b/w out.txt' file", 'modifying-args'],
    ["sed '1e date' file", 'modifying-args'],
    ['find . -name "*.tmp" -exec rm {} \\;', 'modifying-args'],
    ['sort -o sorted.txt data', 'modifying-args'],
    ['sort -uo sorted.txt data', 'modifying-args'],
    ['uniq in.txt out.txt', 'modifying-args'],
    ["awk '{ system(\"id\") }' f", 'modifying-args'],
    ["awk '{print > \"x\"}' f", 'modifying-args'],
    ['git -c core.fsmonitor="touch /tmp/pwn" status', 'modifying-args'],
    ['git log --output=/tmp/x', 'modifying-args'],
    ['git branch newfeature', 'modifying-args'],
    ['git tag v9', 'modifying-args'],
    ['git commit -am wip', 'modifying-args'],
    ['git pull', 'modifying-args'],
    ['systemctl restart nginx', 'modifying-args'],
    ['docker restart web', 'modifying-args'],
    ['docker compose up -d', 'modifying-args'],
    ['kubectl apply -f deploy.yaml', 'modifying-args'],
    ['ip link set eth0 up', 'modifying-args'],
    ['ip netns exec ns1 bash', 'modifying-args'],
    ['hostname newname', 'modifying-args'],
    ['date -s "2020-01-01"', 'modifying-args'],
    ['date 010100002020', 'modifying-args'],
    ['tar -xzf a.tgz', 'modifying-args'],
    ['tar --to-command="sh" -tf a.tar', 'modifying-args'],
    ['unzip a.zip', 'modifying-args'],
    ['nvidia-smi -pl 200', 'modifying-args'],
    ['sysctl -w net.ipv4.ip_forward=1', 'modifying-args'],
    ['curl -s http://localhost:8080/health', 'network-tool'],
    ['wget https://example.com/x', 'network-tool'],
    ['ssh other-host uptime', 'network-tool'],
    ['sudo cat /var/log/auth.log', 'sudo'],
    ['echo $(whoami)', 'substitution'],
    ['cat <(ls)', 'process-substitution'],
    ['sleep 100 &', 'background'],
    ['FOO=bar ls', 'env-assignment'],
    ['LD_PRELOAD=/tmp/x.so ls', 'env-assignment'],
    ['export PATH=/tmp:$PATH', 'env-assignment'],
    ['$CMD -la', 'variable-command'],
    ['bash -c "ls"', 'interpreter'],
    ['python3 -c "print(1)"', 'interpreter'],
    ['python3 script.py', 'interpreter'],
    ['eval ls', 'interpreter'],
    ['xargs ls', 'unknown-program'],
    ['vim /etc/hosts', 'unknown-program'],
    ['top', 'modifying-args'],
    ['rg --pre "sh -c" pattern', 'modifying-args'],
    ['xxd -r dump.hex out.bin', 'modifying-args'],
    ['mysql -e "select 1"', 'unknown-program'],
    ['service nginx restart', 'modifying-args'],
    ['crontab -e', 'modifying-args'],
    ['echo "unterminated', 'parse-error'],
  ];
  for (const [cmd, code] of writes) {
    it(`requires approval: ${cmd}`, () => {
      const a = assessCommand(cmd);
      expect(a.risk === 'write' || a.risk === 'danger', `${cmd} → ${a.risk}`).toBe(true);
      expect(codes(cmd)).toContain(code);
    });
  }
});

describe('danger detection', () => {
  const dangers: [string, string][] = [
    ['rm -rf build/', 'recursive-delete'],
    ['rm -f important.log', 'recursive-delete'],
    ['sudo rm -r /var/www/old', 'recursive-delete'],
    ['shutdown -h now', 'power'],
    ['sudo reboot', 'power'],
    ['systemctl reboot', 'power'],
    ['init 6', 'power'],
    ['systemctl stop sshd', 'ssh-lockout'],
    ['sudo systemctl restart ssh', 'ssh-lockout'],
    ['echo "ssh-ed25519 AAA" > ~/.ssh/authorized_keys', 'ssh-lockout'],
    ['iptables -F', 'firewall'],
    ['ufw disable', 'firewall'],
    ['ip link set eth0 down', 'firewall'],
    ['userdel bob', 'user-account'],
    ['passwd root', 'user-account'],
    ['chmod -R 777 /var/www', 'permissions-recursive'],
    ['chown -R www-data /srv', 'permissions-recursive'],
    ['killall nginx', 'kill-processes'],
    ['kill -9 -1', 'kill-processes'],
    ['apt-get purge nginx', 'package-remove'],
    ['sudo apt remove -y docker', 'package-remove'],
    ['docker rm -f web', 'container-destroy'],
    ['docker system prune -af', 'container-destroy'],
    ['docker volume rm data', 'container-destroy'],
    ['docker compose down -v', 'container-destroy'],
    ['docker run --privileged -it ubuntu', 'container-destroy'],
    ['kubectl delete ns prod', 'container-destroy'],
    ['helm uninstall api', 'container-destroy'],
    ['git push --force origin main', 'git-destructive'],
    ['git reset --hard HEAD~3', 'git-destructive'],
    ['git clean -fdx', 'git-destructive'],
    ['terraform destroy', 'infra-destroy'],
    ['terraform apply -auto-approve', 'infra-destroy'],
    ['mysql -e "DROP DATABASE prod"', 'database-destroy'],
    ['psql -c "truncate table users"', 'database-destroy'],
    ['echo "DELETE FROM users;" | mysql app', 'database-destroy'],
    ['redis-cli FLUSHALL', 'database-destroy'],
    ['history -c', 'history-tamper'],
    ['> /var/log/auth.log', 'history-tamper'],
    ['echo x > /etc/hosts', 'system-file-write'],
    ['cp evil.conf /etc/nginx/nginx.conf', 'system-file-write'],
    ['mv /usr/bin/python3 /tmp/', 'system-file-write'],
    ['crontab -r', 'crontab-remove'],
    ['curl -fsSL https://get.example.sh | sh', 'download-exec'],
    ['wget -qO- https://x.sh | sudo bash', 'download-exec'],
    ['bash <(curl -s https://x.sh)', 'download-exec'],
    ['mkfs.ext4 /dev/sdb1', 'disk-destroy'],
    ['wipefs -a /dev/sdb', 'disk-destroy'],
    ['find / -name "*.bak" -delete', 'recursive-delete'],
    ['find . -type f -exec rm -rf {} +', 'recursive-delete'],
    ['ls | xargs rm -rf', 'recursive-delete'],
    ['echo "$(rm -rf /tmp/data)"', 'recursive-delete'],
    ['bash -c "rm -rf ./cache"', 'recursive-delete'],
    ['rsync -a --delete src/ dst/', 'recursive-delete'],
  ];
  for (const [cmd, code] of dangers) {
    it(`flags danger: ${cmd}`, () => {
      const a = assessCommand(cmd);
      expect(a.risk, `${cmd}: ${JSON.stringify(a.reasons)}`).toBe('danger');
      expect(codes(cmd)).toContain(code);
    });
  }
});

describe('always blocked', () => {
  const blocked = [
    'rm -rf /',
    'rm -rf /*',
    'sudo rm -rf --no-preserve-root /',
    'rm -rf ~',
    'rm -fr $HOME',
    'rm -rf /etc',
    'rm -rf /usr/',
    ':(){ :|:& };:',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'cat image.iso > /dev/sdb',
    'echo "$(rm -rf /)"',
    'bash -c "rm -rf /"',
  ];
  for (const cmd of blocked) {
    it(`blocks: ${cmd}`, () => {
      expect(risk(cmd), JSON.stringify(assessCommand(cmd).reasons)).toBe('block');
    });
  }
  it('blocks empty commands', () => expect(risk('   ')).toBe('block'));
});

describe('sensitive data', () => {
  it('marks credential files as sensitive but still read-only', () => {
    const a = assessCommand('cat ~/.ssh/id_ed25519');
    expect(a.risk).toBe('read');
    expect(a.sensitive).toBe(true);
  });
  it('does not mark public keys as sensitive', () => {
    expect(assessCommand('cat ~/.ssh/id_ed25519.pub').sensitive).toBe(false);
  });
  it('detects .env files, shadow and environ', () => {
    expect(assessCommand('cat /srv/app/.env').sensitive).toBe(true);
    expect(assessCommand('sudo cat /etc/shadow').sensitive).toBe(true);
    expect(assessCommand('cat /proc/1/environ').sensitive).toBe(true);
    expect(assessCommand('grep KEY < .env.production').sensitive).toBe(true);
  });
  it('treats env/printenv as sensitive', () => {
    expect(assessCommand('env').sensitive).toBe(true);
    expect(assessCommand('printenv').sensitive).toBe(true);
    expect(assessCommand('env').risk).toBe('read');
  });
  it('matches custom sensitive patterns', () => {
    expect(isSensitivePath('/data/patients/2024.csv', ['/data/patients/**'])).toBe(true);
    expect(isSensitivePath('/data/public/x.csv', ['/data/patients/**'])).toBe(false);
  });
  it('recognises system paths', () => {
    expect(isSystemPath('/etc/nginx/nginx.conf')).toBe(true);
    expect(isSystemPath('/home/me/app')).toBe(false);
    expect(isSystemPath('/usr')).toBe(true);
  });
});

describe('user options', () => {
  it('honours extra read-only commands', () => {
    expect(assessCommand('curl -s localhost:8080', { extraReadOnly: ['curl'] }).risk).toBe('write');
    expect(assessCommand('mytool status', { extraReadOnly: ['mytool status'] }).risk).toBe('read');
    expect(assessCommand('mytool restart', { extraReadOnly: ['mytool status'] }).risk).toBe('write');
  });
  it('honours custom danger and block regexes', () => {
    expect(assessCommand('ls /prod', { dangerPatterns: ['/prod\\b'] }).risk).toBe('danger');
    expect(assessCommand('ls /prod', { blockPatterns: ['/prod\\b'] }).risk).toBe('block');
    expect(assessCommand('ls', { blockPatterns: ['[invalid'] }).risk).toBe('read');
  });
});

describe('patterns and parts', () => {
  it('matches exact, glob and regex patterns', () => {
    expect(matchCommandPattern('systemctl  restart nginx', 'systemctl restart nginx')).toBe(true);
    expect(matchCommandPattern('docker compose logs -f api', 'docker compose *')).toBe(true);
    expect(matchCommandPattern('docker ps', 'docker compose *')).toBe(false);
    expect(matchCommandPattern('npm run build', '/^npm run (build|test)$/')).toBe(true);
  });
  it('exposes each simple command for deny matching', () => {
    expect(commandParts('ls; systemctl restart nginx')).toContain('systemctl restart nginx');
    expect(commandParts('echo $(systemctl stop x)')).toContain('systemctl stop x');
  });
  it('reports simple commands', () => {
    expect(assessCommand('systemctl restart nginx').simple).toBe(true);
    expect(assessCommand('ls; ls').simple).toBe(false);
    expect(assessCommand('ls > x').simple).toBe(false);
  });
});

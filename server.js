const express = require('express');
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');
const { execFile, exec } = require('child_process');
const os = require('os');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const IS_WIN = process.platform === 'win32';

const UBVINFO_PATH = '/mnt/.rofs/usr/share/unifi-protect/app/node_modules/.bin/ubnt_ubvinfo';
const VIDEO_BASE   = '/srv/unifi-protect/video';
const WORK_DIR     = path.join(os.tmpdir(), 'nvr-ubv');
const REMUX_DIR    = path.join(os.tmpdir(), 'nvr-remux');
[WORK_DIR, REMUX_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// Cross-platform remux resolution
function findRemux() {
  const configPath = path.join(__dirname, '.pb-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.remuxPath && fs.existsSync(cfg.remuxPath)) return cfg.remuxPath;
    } catch (_) {}
  }
  const bin = IS_WIN ? 'remux.exe' : 'remux';
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', bin),
    IS_WIN ? null : '/usr/local/bin/remux',
    path.join(os.tmpdir(), 'pb-remux', 'target', 'release', bin),
    path.join(os.tmpdir(), 'unifi-protect-remux', 'target', 'release', bin),
    path.join(REMUX_DIR, bin),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

const CHECKS = [
  { id: 'firmware', label: 'Firmware version', cmd: 'ubnt-device-info firmware 2>/dev/null || cat /etc/version 2>/dev/null || echo "unknown"', category: 'system' },
  { id: 'uptime', label: 'System uptime', cmd: 'uptime', category: 'system' },
  { id: 'memory', label: 'System memory', cmd: 'free -h', category: 'system' },
  { id: 'processes', label: 'Top processes by memory', cmd: 'ps aux --sort=-%mem | head -12', category: 'system' },
  { id: 'cpu_temp', label: 'CPU temperature', cmd: 'cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | awk \'{print $1/1000 "C"}\' || sensors 2>/dev/null | head -20 || echo "sensors not available"', category: 'system' },
  { id: 'load_avg', label: 'Load average', cmd: 'cat /proc/loadavg', category: 'system' },
  { id: 'storage', label: 'Storage usage (/volume1)', cmd: 'df -h /volume1', category: 'storage' },
  { id: 'storage_dirs', label: 'Volume1 directory sizes', cmd: 'du -sh /volume1/* 2>/dev/null | sort -h || echo "no data"', category: 'storage' },
  { id: 'inode_usage', label: 'Inode usage', cmd: 'df -i /volume1', category: 'storage' },
  { id: 'tmp_space', label: 'Temp space usage', cmd: 'df -h /tmp 2>/dev/null && du -sh /tmp/* 2>/dev/null | sort -rh | head -8 || echo "no tmp data"', category: 'storage' },
  { id: 'raid', label: 'RAID array status', cmd: 'cat /proc/mdstat 2>/dev/null || echo "mdstat not available"', category: 'storage' },
  { id: 'disk_io', label: 'Disk I/O stats', cmd: 'iostat -x 1 1 2>/dev/null | head -20 || cat /proc/diskstats | grep -v "^   0" | head -15', category: 'storage' },
  { id: 'ms_status', label: 'ms.service status', cmd: 'systemctl status ms --no-pager 2>&1 | head -20', category: 'services' },
  { id: 'ms_ram', label: 'ms.service RAM usage', cmd: 'pgrep -x ms > /dev/null && cat /proc/$(pgrep -x ms)/status | grep -E "VmRSS|VmPeak|VmSize" || echo "ms not running"', category: 'services' },
  { id: 'ms_uptime', label: 'ms.service start time', cmd: 'systemctl show ms --property=ActiveEnterTimestamp --no-pager 2>/dev/null || ps -o pid,lstart -p $(pgrep -x ms) 2>/dev/null || echo "unknown"', category: 'services' },
  { id: 'ms_fd', label: 'ms open file descriptors', cmd: 'ls /proc/$(pgrep -x ms)/fd 2>/dev/null | wc -l || echo "ms not running"', category: 'services' },
  { id: 'listener_leak', label: 'Listener leak warnings', cmd: 'grep -c "MaxListenersExceededWarning" /srv/ms/logs/ms.err.00.log 2>/dev/null || echo "0"', category: 'services' },
  { id: 'ms_port', label: 'Port 7443 listening', cmd: 'ss -tlnp | grep 7443 || echo "port 7443 NOT listening"', category: 'services' },
  { id: 'all_services', label: 'All UniFi service states', cmd: 'systemctl list-units "unifi*" "ms*" --no-pager --plain 2>&1 | head -20', category: 'services' },
  { id: 'unifi_core', label: 'unifi-core status', cmd: 'systemctl status unifi-core --no-pager 2>&1 | head -10', category: 'services' },
  { id: 'camera_inventory', label: 'Camera MAC inventory', cmd: 'grep -oE "[0-9A-F]{12}_[012]" /srv/ms/logs/ms.err.00.log 2>/dev/null | sort -u | sed "s/_0/ [main]/" | sed "s/_1/ [sub1]/" | sed "s/_2/ [sub2]/" || echo "no camera data"', category: 'cameras' },
  { id: 'fps_zero', label: 'Cameras with fps=0', cmd: 'grep "fps=0" /srv/ms/logs/ms.err.00.log 2>/dev/null | grep -oE "name=[A-Z0-9]+" | sort -u | sed "s/name=//" || echo "none"', category: 'cameras' },
  { id: 'camera_errors', label: 'Camera connection errors', cmd: 'grep -E "fps=0|GStreamer error|SDP contains|No supported" /srv/ms/logs/ms.err.00.log 2>/dev/null | tail -25 | sed \'s|rtsp://[^@]*@|rtsp://REDACTED@|g\' || echo "none found"', category: 'cameras' },
  { id: 'camera_reachability', label: 'Camera IP ping test', cmd: 'grep -oE "rtsp://[^/]+" /srv/ms/logs/ms.err.00.log 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+" | sort -u | while read ip; do ping -c1 -W1 "$ip" > /dev/null 2>&1 && echo "OK   $ip" || echo "FAIL $ip"; done || echo "no IPs found in logs"', category: 'cameras' },
  { id: 'dead_protocols', label: 'Stuck protocol handlers', cmd: 'grep "CleanupDeadProtocols" /srv/ms/logs/ms.err.00.log 2>/dev/null | tail -8 || echo "none"', category: 'cameras' },
  { id: 'network_interfaces', label: 'Network interfaces', cmd: 'ip -br addr show', category: 'network' },
  { id: 'default_route', label: 'Default gateway / routes', cmd: 'ip route show', category: 'network' },
  { id: 'dns', label: 'DNS / cloud reachability', cmd: 'cat /etc/resolv.conf && echo "---" && nslookup cloud.ui.com 2>&1 | head -5 || echo "nslookup not available"', category: 'network' },
  { id: 'open_ports', label: 'NVR listening ports', cmd: 'ss -tlnp | grep -E "7080|7443|7447|1935|6789|443|80|22"', category: 'network' },
  { id: 'mqtt_connectivity', label: 'MQTT / cloud log entries', cmd: 'grep -iE "mqtt|cloud|connect" /srv/ms/logs/ms.err.00.log 2>/dev/null | tail -10 || echo "no mqtt logs"', category: 'network' },
  { id: 'ms_errors', label: 'ms recent errors', cmd: 'tail -40 /srv/ms/logs/ms.err.00.log 2>/dev/null | sed \'s|rtsp://[^@]*@|rtsp://REDACTED@|g\' || echo "log not found"', category: 'logs' },
  { id: 'ms_crash', label: 'ms crash log', cmd: 'tail -30 /srv/ms/logs/ms.crash.log 2>/dev/null | sed \'s|rtsp://[^@]*@|rtsp://REDACTED@|g\' || echo "no crash log"', category: 'logs' },
  { id: 'ms_crash_count', label: 'ms crash log files', cmd: 'ls -lh /srv/ms/logs/ms.crash.log* 2>/dev/null && wc -l /srv/ms/logs/ms.crash.log* 2>/dev/null || echo "none"', category: 'logs' },
  { id: 'rotation', label: 'Storage rotation activity', cmd: 'grep -i "rotat\\|delet\\|prun\\|reclaim\\|storage" /srv/ms/logs/ms.err.00.log 2>/dev/null | tail -15 || echo "no rotation activity found"', category: 'logs' },
  { id: 'log_sizes', label: 'ms log file sizes', cmd: 'ls -lh /srv/ms/logs/ 2>/dev/null || echo "log dir not found"', category: 'logs' },
  { id: 'oom_events', label: 'OOM killer events', cmd: 'journalctl -k --no-pager 2>/dev/null | grep -i "oom\\|killed process" | tail -10 || dmesg | grep -i "oom\\|killed process" | tail -10 || echo "none found"', category: 'logs' },
  { id: 'journalctl_errors', label: 'System journal errors (60min)', cmd: 'journalctl --since "60 minutes ago" -p err --no-pager 2>&1 | tail -25 || echo "none"', category: 'logs' }
];

const QUICK_ACTIONS = [
  { id: 'ms_ram_now', label: 'Check ms RAM now', cmd: 'cat /proc/$(pgrep -x ms)/status 2>/dev/null | grep -E "VmRSS|VmPeak" && echo "---" && date', confirm: false, danger: false },
  { id: 'storage_free', label: 'Storage free now', cmd: 'df -h /volume1 && echo "---" && du -sh /volume1/* 2>/dev/null | sort -rh | head -10', confirm: false, danger: false },
  { id: 'rotation_check', label: 'Check rotation activity', cmd: 'df -h /volume1 && echo "---" && grep -i "rotat\\|delet" /srv/ms/logs/ms.err.00.log | tail -8', confirm: false, danger: false },
  { id: 'listener_count', label: 'Check listener leak', cmd: 'echo "MaxListeners warnings:" && grep -c "MaxListenersExceededWarning" /srv/ms/logs/ms.err.00.log 2>/dev/null && echo "Log files:" && ls /srv/ms/logs/ms.err.00.log* 2>/dev/null | wc -l', confirm: false, danger: false },
  { id: 'tail_errors', label: 'Tail ms errors (10s)', cmd: 'timeout 10 tail -f /srv/ms/logs/ms.err.00.log 2>/dev/null | sed \'s|rtsp://[^@]*@|rtsp://REDACTED@|g\'', confirm: false, danger: false },
  { id: 'camera_ping_all', label: 'Ping all camera IPs', cmd: 'grep -oE "rtsp://[^/]+" /srv/ms/logs/ms.err.00.log 2>/dev/null | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+" | sort -u | while read ip; do ping -c1 -W1 "$ip" > /dev/null 2>&1 && echo "OK   $ip" || echo "FAIL $ip"; done', confirm: false, danger: false },
  { id: 'restart_ms', label: 'Restart ms.service', cmd: 'systemctl restart ms && sleep 3 && systemctl status ms --no-pager | head -12', confirm: true, danger: true },
  { id: 'reboot_nvr', label: 'Reboot NVR', cmd: 'echo "Rebooting..." && sleep 2 && reboot', confirm: true, danger: true },
];

function sshExec(host, port, username, password, cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('keyboard-interactive', (name, descr, lang, prompts, finish) => finish([password]));
    let output = '';
    const timer = setTimeout(() => { conn.end(); resolve(output + '\n[timed out]'); }, timeout);
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); resolve('Error: ' + err.message); return; }
        stream.on('data', d => output += d);
        stream.stderr.on('data', d => output += d);
        stream.on('close', () => { clearTimeout(timer); conn.end(); resolve(output.trim()); });
      });
    });
    conn.on('error', err => { clearTimeout(timer); reject(err); });
    conn.connect({ host, port: parseInt(port) || 22, username, tryKeyboard: true, readyTimeout: 15000 });
  });
}

function sftpGet(host, port, username, password, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('keyboard-interactive', (name, descr, lang, prompts, finish) => finish([password]));
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        sftp.fastGet(remotePath, localPath, {}, (err) => {
          conn.end();
          if (err) reject(err); else resolve(localPath);
        });
      });
    });
    conn.on('error', err => reject(err));
    conn.connect({ host, port: parseInt(port) || 22, username, tryKeyboard: true, readyTimeout: 15000 });
  });
}

function analyzeResults(results) {
  const issues = [];
  const ok = [];
  const storage = results.storage?.output || '';
  const storageMatch = storage.match(/(\d+)%/);
  if (storageMatch) {
    const pct = parseInt(storageMatch[1]);
    if (pct >= 99) issues.push({ severity: 'critical', msg: `Storage at ${pct}% — snapshots/playback/export will fail` });
    else if (pct >= 90) issues.push({ severity: 'warning', msg: `Storage at ${pct}% — rotation may stall soon` });
    else ok.push(`Storage at ${pct}% (healthy)`);
  }
  const inodes = results.inode_usage?.output || '';
  const inodePct = inodes.match(/(\d+)%/g);
  if (inodePct) {
    const pct = parseInt(inodePct[inodePct.length - 1]);
    if (pct >= 90) issues.push({ severity: 'critical', msg: `Inode usage at ${pct}% — filesystem may reject new files` });
  }
  const msStatus = results.ms_status?.output || '';
  if (msStatus.includes('active (running)')) ok.push('ms.service running');
  else issues.push({ severity: 'critical', msg: 'ms.service is NOT running' });
  const msRam = results.ms_ram?.output || '';
  const ramMatch = msRam.match(/VmRSS:\s+(\d+)/);
  if (ramMatch) {
    const mb = Math.round(parseInt(ramMatch[1]) / 1024);
    if (mb > 14000) issues.push({ severity: 'critical', msg: `ms RAM at ${mb.toLocaleString()}MB — memory leak active, crash imminent` });
    else if (mb > 8000) issues.push({ severity: 'warning', msg: `ms RAM at ${mb.toLocaleString()}MB — elevated, monitor closely` });
    else ok.push(`ms RAM: ${mb.toLocaleString()}MB (healthy)`);
  }
  const listenerCount = parseInt(results.listener_leak?.output || '0');
  if (listenerCount > 50) issues.push({ severity: 'critical', msg: `${listenerCount} MaxListenersExceededWarning events — listener leak active` });
  else if (listenerCount > 0) issues.push({ severity: 'warning', msg: `${listenerCount} MaxListenersExceededWarning events` });
  else ok.push('No listener leak warnings');
  const port7443 = results.ms_port?.output || '';
  if (port7443.includes('7443')) ok.push('Port 7443 listening');
  else issues.push({ severity: 'critical', msg: 'Port 7443 not listening — WebSockets will fail' });
  const fdCount = parseInt(results.ms_fd?.output || '0');
  if (fdCount > 5000) issues.push({ severity: 'warning', msg: `ms has ${fdCount.toLocaleString()} open file descriptors` });
  const rotation = results.rotation?.output || '';
  if (rotation === 'no rotation activity found') issues.push({ severity: 'warning', msg: 'No storage rotation activity in ms logs' });
  else ok.push('Storage rotation active');
  const crash = results.ms_crash?.output || '';
  if (!crash.includes('no crash log') && crash.length > 10) issues.push({ severity: 'warning', msg: 'ms crash log has entries — check Logs tab' });
  else ok.push('No crash log entries');
  const oom = results.oom_events?.output || '';
  if (!oom.includes('none found') && oom.length > 5) issues.push({ severity: 'critical', msg: 'OOM killer events found' });
  const fps0Lines = (results.fps_zero?.output || '').split('\n').filter(l => l.trim() && l !== 'none');
  if (fps0Lines.length > 0) issues.push({ severity: 'warning', msg: `${fps0Lines.length} camera(s) with fps=0: ${fps0Lines.slice(0,3).join(', ')}` });
  const cameraErrors = results.camera_errors?.output || '';
  const gstErrors = (cameraErrors.match(/GStreamer error/g) || []).length;
  if (gstErrors > 0) issues.push({ severity: 'info', msg: `${gstErrors} GStreamer errors (ONVIF substream incompatibility — camera-side)` });
  const reach = results.camera_reachability?.output || '';
  const failedCams = (reach.match(/^FAIL/gm) || []).length;
  const okCams = (reach.match(/^OK/gm) || []).length;
  if (failedCams > 0) issues.push({ severity: 'warning', msg: `${failedCams} camera IP(s) not responding to ping` });
  else if (okCams > 0) ok.push(`All ${okCams} camera IPs reachable`);
  return { issues, ok };
}

app.get('/checks', (req, res) => res.json(CHECKS));
app.get('/actions', (req, res) => res.json(QUICK_ACTIONS));

app.post('/diagnose', async (req, res) => {
  const { host, port, username, password } = req.body;
  if (!host || !username || !password) return res.status(400).json({ error: 'Missing required fields' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'start', total: CHECKS.length });
  const conn = new Client();
  conn.on('keyboard-interactive', (name, descr, lang, prompts, finish) => finish([password]));
  const results = {};
  let idx = 0;
  function runNext() {
    if (idx >= CHECKS.length) {
      conn.end();
      send({ type: 'analysis', analysis: analyzeResults(results) });
      send({ type: 'done', results });
      res.end();
      return;
    }
    const check = CHECKS[idx++];
    send({ type: 'progress', id: check.id, label: check.label, idx });
    conn.exec(check.cmd, (err, stream) => {
      if (err) {
        results[check.id] = { label: check.label, category: check.category, output: 'Error: ' + err.message, error: true };
        send({ type: 'result', id: check.id, result: results[check.id] });
        runNext(); return;
      }
      let output = '';
      stream.on('data', d => output += d);
      stream.stderr.on('data', d => output += d);
      stream.on('close', () => {
        results[check.id] = { label: check.label, category: check.category, output: output.trim() };
        send({ type: 'result', id: check.id, result: results[check.id] });
        runNext();
      });
    });
  }
  conn.on('ready', () => { send({ type: 'connected' }); runNext(); });
  conn.on('error', err => { send({ type: 'error', message: err.message }); res.end(); });
  conn.connect({ host, port: parseInt(port) || 22, username, tryKeyboard: true, readyTimeout: 15000 });
});

app.post('/action', async (req, res) => {
  const { host, port, username, password, actionId } = req.body;
  const action = QUICK_ACTIONS.find(a => a.id === actionId);
  if (!action) return res.status(404).json({ error: 'Not found' });
  if (!host || !username || !password) return res.status(400).json({ error: 'Missing credentials' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const conn = new Client();
  conn.on('keyboard-interactive', (name, descr, lang, prompts, finish) => finish([password]));
  conn.on('ready', () => {
    send({ type: 'start', label: action.label });
    conn.exec(action.cmd, (err, stream) => {
      if (err) { send({ type: 'output', text: 'Error: ' + err.message }); send({ type: 'done' }); res.end(); return; }
      stream.on('data', d => send({ type: 'output', text: d.toString() }));
      stream.stderr.on('data', d => send({ type: 'output', text: d.toString() }));
      stream.on('close', () => { send({ type: 'done' }); conn.end(); res.end(); });
    });
  });
  conn.on('error', err => { send({ type: 'error', message: err.message }); res.end(); });
  conn.connect({ host, port: parseInt(port) || 22, username, tryKeyboard: true, readyTimeout: 12000 });
});

app.post('/poll-ram', async (req, res) => {
  const { host, port, username, password } = req.body;
  if (!host || !username || !password) return res.status(400).json({ error: 'Missing fields' });
  try {
    const output = await sshExec(host, port, username, password,
      'pgrep -x ms > /dev/null && cat /proc/$(pgrep -x ms)/status | grep VmRSS || echo "ms not running"');
    const match = output.match(/VmRSS:\s+(\d+)/);
    const mb = match ? Math.round(parseInt(match[1]) / 1024) : null;
    res.json({ mb, raw: output, ts: Date.now() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/report', (req, res) => {
  const { results, analysis, host, timestamp } = req.body;
  const lines = [];
  lines.push('UniFi NVR Diagnostic Report');
  lines.push('='.repeat(60));
  lines.push(`Host:      ${host}`);
  lines.push(`Generated: ${timestamp}`);
  lines.push('');
  lines.push('SUMMARY');
  lines.push('-'.repeat(40));
  if (!analysis.issues.length) lines.push('No issues detected.');
  else analysis.issues.forEach(i => lines.push(`[${i.severity.toUpperCase().padEnd(8)}] ${i.msg}`));
  lines.push('');
  analysis.ok.forEach(o => lines.push(`[OK      ] ${o}`));
  lines.push('');
  ['system','storage','services','cameras','network','logs'].forEach(cat => {
    const catResults = Object.entries(results).filter(([,v]) => v.category === cat);
    if (!catResults.length) return;
    lines.push(cat.toUpperCase());
    lines.push('-'.repeat(40));
    catResults.forEach(([,v]) => { lines.push(`\n[${v.label}]`); lines.push(v.output); });
    lines.push('');
  });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="nvr-diag-${Date.now()}.txt"`);
  res.send(lines.join('\n'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// UBV RECOVERY — 100% read-only on the NVR. No footage deleted or modified.
// All processing happens locally on the machine running this tool.
// ═══════════════════════════════════════════════════════════════════════════════

// Fetch camera name->MAC map from Protect's PostgreSQL database
// Newer UniFi firmware (ENVR etc.) uses a separate postgres cluster on port 5433
app.post('/ubv/camera-names', async (req, res) => {
  const { host, port, username, password } = req.body;
  if (!host || !username || !password) return res.status(400).json({ error: 'Missing credentials' });
  try {
    // Verified working command — uses pipe separator, postgres port 5433 (new firmware) or 5432 (old)
    const cmd = `su -s /bin/sh postgres -c 'psql -p 5433 -d unifi-protect -t -A -F"|" -c "SELECT name, mac FROM cameras;"' 2>/dev/null || su -s /bin/sh postgres -c 'psql -p 5432 -d unifi-protect -t -A -F"|" -c "SELECT name, mac FROM cameras;"' 2>/dev/null || echo "UNAVAILABLE"`;
    const out = await sshExec(host, port, username, password, cmd, 15000);
    console.log('[camera-names] raw output:', JSON.stringify(out.slice(0, 200)));

    const macToName = {};
    if (!out || out.trim() === 'UNAVAILABLE' || !out.includes('|')) {
      console.log('[camera-names] no pipe-delimited data found');
      return res.json({ macToName });
    }

    out.trim().split('\n').forEach(line => {
      const idx = line.indexOf('|');
      if (idx === -1) return;
      const name = line.slice(0, idx).trim();
      const mac = line.slice(idx + 1).trim().replace(/:/g, '').toUpperCase();
      if (name && mac) macToName[mac] = name;
    });

    console.log('[camera-names] found', Object.keys(macToName).length, 'cameras');
    res.json({ macToName });
  } catch(e) {
    console.log('[camera-names] error:', e.message);
    res.json({ macToName: {} });
  }
});


// List dates with footage
app.post('/ubv/dates', async (req, res) => {
  const { host, port, username, password } = req.body;
  if (!host || !username || !password) return res.status(400).json({ error: 'Missing credentials' });
  try {
    const out = await sshExec(host, port, username, password,
      `find ${VIDEO_BASE} -mindepth 3 -maxdepth 3 -type d 2>/dev/null | sed 's|${VIDEO_BASE}/||' | sort -r | head -90`,
      20000);
    const dates = out.split('\n').map(l => l.trim()).filter(l => /^\d{4}\/\d{2}\/\d{2}$/.test(l));
    res.json({ dates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List UBV files for a date (YYYY/MM/DD)
app.post('/ubv/list', async (req, res) => {
  const { host, port, username, password, datePath } = req.body;
  if (!host || !username || !password || !datePath) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(datePath)) return res.status(400).json({ error: 'Invalid date path' });
  const remoteDir = `${VIDEO_BASE}/${datePath}`;
  try {
    const out = await sshExec(host, port, username, password,
      `ls -lh "${remoteDir}"/*.ubv 2>/dev/null | awk '{print $5, $9}' || echo "NO_FILES"`, 15000);
    if (out.trim() === 'NO_FILES' || !out.trim()) return res.json({ files: [] });
    const files = out.split('\n').map(line => {
      const parts = line.trim().split(/\s+/);
      const size = parts[0];
      const fullPath = parts[1] || '';
      const name = path.basename(fullPath);
      const m = name.match(/^([0-9A-Fa-f]{12})_(\d)_\w+_(\d+)\.ubv$/);
      const tsMs = m ? parseInt(m[3]) : 0;
      const utcDate = tsMs ? new Date(tsMs).toISOString().replace('T',' ').substring(0,19) + ' UTC' : '';
      return { name, size, fullPath, mac: m?.[1] || '?', channel: m?.[2] || '?', utcDate };
    }).filter(f => f.name.endsWith('.ubv'));
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Inspect a UBV file (read-only: ubnt_ubvinfo only)
app.post('/ubv/inspect', async (req, res) => {
  const { host, port, username, password, remotePath } = req.body;
  if (!host || !username || !password || !remotePath) return res.status(400).json({ error: 'Missing fields' });
  if (!remotePath.startsWith(VIDEO_BASE)) return res.status(400).json({ error: 'Path outside video directory' });
  try {
    const out = await sshExec(host, port, username, password,
      `${UBVINFO_PATH} -f "${remotePath}" 2>&1 | head -80`, 25000);
    res.json({ info: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate mapping .ubv.txt sidecar (writes only a small text file next to the UBV — does NOT touch footage)
app.post('/ubv/gen-mapping', async (req, res) => {
  const { host, port, username, password, remotePath } = req.body;
  if (!host || !username || !password || !remotePath) return res.status(400).json({ error: 'Missing fields' });
  if (!remotePath.startsWith(VIDEO_BASE)) return res.status(400).json({ error: 'Path outside video directory' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  const mappingPath = remotePath + '.txt';
  try {
    send({ type: 'log', text: `Generating mapping file...\nOutput: ${mappingPath}\n\n` });
    const out = await sshExec(host, port, username, password,
      `${UBVINFO_PATH} -f "${remotePath}" -P > "${mappingPath}" 2>&1 && echo "__MAPPING_OK__"`, 90000);
    if (out.includes('__MAPPING_OK__')) {
      send({ type: 'log', text: `✓ Mapping file created.\n` });
      send({ type: 'done', mappingPath });
    } else {
      send({ type: 'log', text: `Output:\n${out}\n` });
      send({ type: 'error', text: 'Mapping may have failed — review output above' });
    }
  } catch (e) { send({ type: 'error', text: e.message }); }
  res.end();
});

// Full recovery pipeline: download UBV → remux → ffmpeg → serve MP4
// The NVR is NEVER written to except for the optional .ubv.txt sidecar, and footage is NEVER deleted.
app.post('/ubv/recover', async (req, res) => {
  const { host, port, username, password, remotePath, fps, trimStart, trimEnd } = req.body;
  if (!host || !username || !password || !remotePath) return res.status(400).json({ error: 'Missing fields' });
  if (!remotePath.startsWith(VIDEO_BASE)) return res.status(400).json({ error: 'Path outside video directory' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  // Keepalive ping every 15s to prevent browser/OS from suspending the SSE stream
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15000);
  const cleanup = () => clearInterval(keepalive);
  res.on('close', cleanup);

  const videoFps = parseFloat(fps) || 20;
  const ubvName = path.basename(remotePath);
  const localUbv = path.join(WORK_DIR, ubvName);
  const localMapping = localUbv + '.txt';
  const remoteMapping = remotePath + '.txt';
  const baseName = ubvName.replace('.ubv', '');
  const outputMp4 = path.join(WORK_DIR, baseName + '_recovered.mp4');
  // Clean up any previous output for this file
  [outputMp4, outputMp4.replace('_recovered.mp4','_trimmed.mp4')].forEach(f => { try { fs.unlinkSync(f); } catch(_){} });

  try {
    // Step 1: Download UBV via SFTP (read-only)
    send({ type: 'step', step: 1, of: 5, text: 'Downloading UBV file from NVR (SFTP, read-only)...' });
    await sftpGet(host, port, username, password, remotePath, localUbv);
    const ubvMB = Math.round(fs.statSync(localUbv).size / 1024 / 1024);
    send({ type: 'log', text: `  ✓ ${ubvMB} MB downloaded to local temp dir\n` });

    // Step 2: Download or generate mapping file
    send({ type: 'step', step: 2, of: 5, text: 'Getting mapping file (.ubv.txt)...' });
    let mappingOk = false;
    try {
      await sftpGet(host, port, username, password, remoteMapping, localMapping);
      send({ type: 'log', text: `  ✓ Mapping file downloaded from NVR\n` });
      mappingOk = true;
    } catch (_) {
      send({ type: 'log', text: `  Mapping not found — generating on NVR now (writes .ubv.txt sidecar only)...\n` });
      const mapOut = await sshExec(host, port, username, password,
        `${UBVINFO_PATH} -f "${remotePath}" -P > "${remoteMapping}" 2>&1 && echo "__OK__"`, 120000);
      if (mapOut.includes('__OK__')) {
        await sftpGet(host, port, username, password, remoteMapping, localMapping);
        send({ type: 'log', text: `  ✓ Mapping generated and downloaded\n` });
        mappingOk = true;
      } else {
        send({ type: 'log', text: `  Warning: mapping generation may have failed. Proceeding anyway.\n  Output: ${mapOut}\n` });
      }
    }

    // Step 3: Locate remux binary (cross-platform)
    send({ type: 'step', step: 3, of: 5, text: 'Checking remux binary...' });
    const remuxBin = findRemux();
    if (!remuxBin) {
      throw new Error(
        'remux binary not found.\n\n' +
        'Run: npm run setup\n' +
        'This will build and install remux automatically.\n\n' +
        'Requires Rust: https://rustup.rs'
      );
    }
    send({ type: 'log', text: `  ✓ Using remux at ${remuxBin}\n` });

    // Step 4: Remux on Mac using locally-built Rust binary
    send({ type: 'step', step: 4, of: 5, text: 'Extracting H.264 from UBV (skipping MP4 container)...' });
    await new Promise((resolve, reject) => {
      // Rust remux uses --flag style; --with-audio=false skips audio extraction
      execFile(remuxBin, ['--mp4=false', '--with-audio=false', localUbv], { cwd: WORK_DIR, timeout: 600000 },
        (err, stdout, stderr) => {
          if (err) {
            // Fallback to Go-style flags for older builds
            execFile(remuxBin, ['-mp4=false', localUbv], { cwd: WORK_DIR, timeout: 600000 },
              (err2, stdout2, stderr2) => err2 ? reject(new Error(stderr2 || stderr || err2.message)) : resolve());
          } else resolve();
        });
    });
    // Rust remux names output files by timestamp, not by source filename.
    // Also supports .hevc for some cameras. Find the newest video file produced.
    const macPrefix = ubvName.split('_')[0]; // e.g. 000C31F732A5
    const videoFiles = fs.readdirSync(WORK_DIR)
      .filter(f => (f.endsWith('.h264') || f.endsWith('.hevc')) && f.startsWith(macPrefix))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(WORK_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first
    if (!videoFiles.length) throw new Error('remux produced no .h264/.hevc file. The UBV may be empty or corrupt.');
    const videoFile = videoFiles[0].name;
    const actualH264 = path.join(WORK_DIR, videoFile);
    const isHevc = videoFile.endsWith('.hevc');
    send({ type: 'log', text: `  ✓ Extracted: ${videoFile} (${isHevc ? 'HEVC/H.265' : 'H.264'})\n` });

    // Step 5: Re-encode with ffmpeg, rebuilding timestamps from frame count
    send({ type: 'step', step: 5, of: 5, text: `Re-encoding with corrected timestamps (fps=${videoFps})...` });
    await new Promise((resolve, reject) => {
      const codec = isHevc ? 'libx265' : 'libx264';
      const args = [
        '-fflags', '+discardcorrupt+igndts',
        '-framerate', String(videoFps),
        '-i', actualH264,
        '-vf', `setpts=N/${videoFps}/TB`,
        '-c:v', codec,
        '-preset', 'ultrafast',
        '-crf', '18',
        '-r', String(videoFps),
        outputMp4
      ];
      execFile('ffmpeg', args, { timeout: 900000 },
        (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve());
    });
    send({ type: 'log', text: `  ✓ MP4 encoded\n` });

    // Optional trim step
    let finalMp4 = outputMp4;
    if (trimStart || trimEnd) {
      const trimmedMp4 = outputMp4.replace('_recovered.mp4', '_trimmed.mp4');
      const trimArgs = ['-i', outputMp4];
      if (trimStart) trimArgs.push('-ss', trimStart);
      if (trimEnd)   trimArgs.push('-to', trimEnd);
      trimArgs.push('-c', 'copy', trimmedMp4);
      try {
        await new Promise((resolve, reject) =>
          execFile('ffmpeg', trimArgs, { timeout: 300000 },
            (err) => err ? reject(err) : resolve()));
        finalMp4 = trimmedMp4;
        send({ type: 'log', text: `  ✓ Trimmed to ${trimStart||'start'} – ${trimEnd||'end'}\n` });
      } catch (e) {
        send({ type: 'log', text: `  ⚠ Trim failed (${e.message}), using full file\n` });
      }
    }

    const finalMB = Math.round(fs.statSync(finalMp4).size / 1024 / 1024);
    send({ type: 'log', text: `\n✓ Recovery complete — ${path.basename(finalMp4)} (${finalMB} MB)\n` });
    send({ type: 'done', downloadKey: path.basename(finalMp4), sizeMB: finalMB });

  } catch (e) {
    send({ type: 'error', text: `\n✗ Failed: ${e.message}\n` });
  } finally {
    cleanup();
    res.end();
  }
});

// Serve recovered MP4 for browser download
app.get('/ubv/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.endsWith('.mp4') && !filename.endsWith('.h264')) return res.status(400).send('Invalid type');
  const filePath = path.join(WORK_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found — it may have been cleaned up');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  fs.createReadStream(filePath).pipe(res);
});

app.listen(3500, () => console.log('NVR Diagnostic + UBV Recovery → http://localhost:3500'));

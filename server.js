#!/usr/bin/env node
/**
 * dev-launcher · 本地项目启动器 Dashboard
 * 零依赖（仅 Node 标准库）：项目一键启动/停止、日志查看、
 * w2 代理场景一键切换（w2 add --force，同名规则集覆盖实现互斥）、led 隧道组合启动。
 *
 * 双击「启动项目面板.command」即可使用；或手动 `node server.js`。
 */
'use strict';

const url = require('url');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync, exec } = require('child_process');

const ROOT = __dirname;
// 每用户独立数据（同一份代码拷给任何人互不干扰）
const DATA_DIR = path.join(process.env.HOME || '/tmp', '.dev-launcher');
const LOG_DIR = '/tmp/dev-launcher/logs';
const SCEN_DIR = path.join(DATA_DIR, 'scenarios');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT_FILE = path.join(DATA_DIR, 'port');
const W2_GROUP = 'open-platform-fe'; // 仓库 projects.json 可覆盖（whistleGroup 字段）

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SCEN_DIR, { recursive: true });

// ---------------------------------------------------------------- 配置与状态

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'projects.json'), 'utf8'));
const SCENARIOS = CFG.scenarios || [];
const GROUP_NAME = CFG.whistleGroup || W2_GROUP;

// ---- 用户项目列表：~/.dev-launcher/projects.local.json（每人一份，与代码分离）----
const LOCAL_FILE = path.join(DATA_DIR, 'projects.local.json');
const REMOVED_FILE = path.join(DATA_DIR, 'removed.json');
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }
function writeJson(f, v) { fs.writeFileSync(f, JSON.stringify(v, null, 2)); }

// 首次运行：种子化（新用户=空；老安装=从仓库旧数据迁移）
if (!fs.existsSync(LOCAL_FILE)) {
  const legacy = readJson(path.join(ROOT, 'custom-projects.json'), []);
  const seed = (CFG.projects || []).map(p => Object.assign({ builtin: true }, p)).concat(legacy);
  writeJson(LOCAL_FILE, seed);
  writeJson(REMOVED_FILE, readJson(path.join(ROOT, 'removed-projects.json'), []));
  try { fs.copyFileSync('/tmp/dev-launcher/state.json', STATE_FILE); } catch { }
  console.log(`[dev-launcher] 首次运行：已初始化用户数据 ${LOCAL_FILE}（${seed.length} 个项目）`);
}
function loadLocal() { return readJson(LOCAL_FILE, []); }
function saveLocal(l) { writeJson(LOCAL_FILE, l); }
function loadRemoved() { return readJson(REMOVED_FILE, []); }
function saveRemoved(l) { writeJson(REMOVED_FILE, l); }
let PROJECTS = loadLocal().filter(p => !loadRemoved().includes(p.id));
function reloadProjects() { PROJECTS = loadLocal().filter(p => !loadRemoved().includes(p.id)); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState() { fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2)); }
const STATE = Object.assign({ procs: {}, installing: {} }, loadState()); // { procs: { id: [{pid,cmd,startedAt}] }, lastScenario, installing: {} }

// ---------------------------------------------------------------- 工具函数

function sh(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: opts.timeout || 8000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
  catch (e) { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// 端口是否有服务在监听（返回监听 pid 列表）
const lsofCache = new Map();
function portPids(port) {
  if (!port) return [];
  const now = Date.now();
  const c = lsofCache.get(port);
  if (c && now - c.t < 1500) return c.v;
  let v = [];
  const out = sh(`lsof -nP -tiTCP:${port} -sTCP:LISTEN 2>/dev/null`);
  if (out) v = out.split('\n').map(s => s.trim()).filter(Boolean);
  lsofCache.set(port, { t: now, v });
  return v;
}

function logFileFor(id, suffix) {
  return path.join(LOG_DIR, `${id}${suffix ? '.' + suffix : ''}.log`);
}

function tailFile(file, lines = 300) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const arr = text.split('\n');
    return { text: arr.slice(-lines).join('\n'), size: text.length };
  } catch { return { text: '(暂无日志)', size: 0 }; }
}

// 从日志嗅探端口（vite "Local: http://localhost:8000" / nest ":3000" / netstat 风格）
function sniffPort(id, fallback) {
  const file = logFileFor(id);
  try {
    // vite 等输出端口数字时常带 ANSI 颜色码（localhost:<ESC>[1m5173），先剥离再匹配
    const text = fs.readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*[mK]/g, '');
    const re = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1?\]):(\d{2,5})/g;
    // 优先 "Local:" / "ready" 行；简单策略：统计所有出现的主机端口，取最后出现的（vite ready 在启动尾部）
    let m, last = null;
    while ((m = re.exec(text))) last = m[1];
    if (last) return Number(last);
  } catch { /* ignore */ }
  return fallback;
}

// ---------------------------------------------------------------- 进程管理

function startProcess(id, step, cb) {
  const proj = PROJECTS.find(p => p.id === id);
  const file = logFileFor(id, step.log);
  const fd = fs.openSync(file, 'a');
  const stamp = `\n===== [${new Date().toLocaleString()}] ${id} :: ${step.cmd} ${(step.args || []).join(' ')} =====\n`;
  fs.writeSync(fd, stamp);
  const stepEnv = Object.assign({}, step.env || {});
  for (const k of Object.keys(stepEnv)) {
    if (String(stepEnv[k]).includes('{PATH}')) stepEnv[k] = String(stepEnv[k]).replace('{PATH}', process.env.PATH || '');
  }
  const child = spawn(step.cmd, step.args || [], {
    cwd: step.cwd || proj.dir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: Object.assign({}, process.env, { FORCE_COLOR: '1' }, stepEnv),
  });
  child.unref();
  fs.closeSync(fd, () => {});
  const rec = { pid: child.pid, cmd: step.cmd, startedAt: Date.now() };
  if (!STATE.procs[id]) STATE.procs[id] = [];
  STATE.procs[id].push(rec);
  saveState();
  if (cb) cb(null, rec);
  return rec;
}

function killPid(pid) {
  if (!pid || !pidAlive(pid)) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { } }
}

function stopProject(id) {
  const recs = (STATE.procs[id] || []);
  recs.forEach(r => killPid(r.pid));
  // 兜底：pkill 匹配模式 + 端口清理
  const proj = PROJECTS.find(p => p.id === id);
  (proj.start || []).forEach(step => {
    if (step.pkill) exec(`pkill -f ${JSON.stringify(step.pkill)}`);
  });
  const port = resolvePort(proj);
  if (port) exec(`lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null`);
  STATE.procs[id] = [];
  saveState();
  setTimeout(() => { const p = resolvePort(proj); if (p) portPids; }, 0);
}

function resolvePort(proj) {
  if (proj.port) return proj.port;
  return sniffPort(proj.id, null);
}

// 启动：缺依赖先自动 install，成功后拉起各进程（串行，支持 delayMs）
function startProject(id, done) {
  const proj = PROJECTS.find(p => p.id === id);
  if (!proj) return done(new Error('unknown project: ' + id));
  // 若已有本启动器起的进程在跑，先提示（不重复起）
  const alive = (STATE.procs[id] || []).some(r => pidAlive(r.pid));
  if (alive) return done(null, { already: true });

  const steps = proj.start || [];
  const runSteps = (i) => {
    if (i >= steps.length) return afterStart(null, done);
    const step = steps[i];
    startProcess(id, step);
    const delay = step.delayMs || 800;
    setTimeout(() => runSteps(i + 1), delay);
  };

  const afterStart = (err, done) => {
    // 启动后自动应用关联的 w2 场景
    const msg = { started: !err };
    if (!err && CFG.autoApplyScenario && proj.scenario) {
      applyScenario(proj.scenario, (sErr, sOut) => {
        done(null, Object.assign(msg, { scenario: proj.scenario, scenarioOk: !sErr }));
      });
    } else done(null, msg);
  };

  if (proj.install && !fs.existsSync(proj.install.marker)) {
    // 自动装依赖（日志追加到主日志）
    const ifd = fs.openSync(logFileFor(id), 'a');
    fs.writeSync(ifd, `\n===== [${new Date().toLocaleString()}] 检测到未安装依赖，自动执行 ${proj.install.cmd} install =====\n`);
    const child = spawn(proj.install.cmd, proj.install.args || ['install'], {
      cwd: proj.install.cwd || proj.dir, detached: true, stdio: ['ignore', ifd, ifd],
    });
    child.unref();
    fs.closeSync(ifd, () => {});
    STATE.installing = STATE.installing || {};
    STATE.installing[id] = { pid: child.pid, at: Date.now() };
    saveState();
    child.on('exit', (code) => {
      STATE.installing[id] = { done: true, code };
      saveState();
      if (code === 0) runSteps(0);
      else done(new Error('install 失败，退出码 ' + code + '（见日志）'));
    });
    // detached + unref 后 exit 事件仍会触发（进程对象还在）
  } else {
    runSteps(0);
  }
}

function installProject(id, done) {
  const proj = PROJECTS.find(p => p.id === id);
  if (!proj || !proj.install) return done(new Error('该项目无需安装依赖'));
  const file = logFileFor(id, 'install');
  const fd = fs.openSync(file, 'a');
  fs.writeSync(fd, `\n===== [${new Date().toLocaleString()}] ${proj.install.cmd} ${(proj.install.args || []).join(' ')} =====\n`);
  const child = spawn(proj.install.cmd, proj.install.args || ['install'], {
    cwd: proj.install.cwd || proj.dir, detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref(); fs.closeSync(fd, () => {});
  STATE.installing = STATE.installing || {};
  STATE.installing[id] = { pid: child.pid, at: Date.now(), manual: true };
  saveState();
  child.on('exit', (code) => { STATE.installing[id] = { done: true, code }; saveState(); });
  done(null, { installing: true });
}

// ---------------------------------------------------------------- w2 与场景

function w2Running() {
  const out = sh('w2 status 2>/dev/null', { timeout: 6000 });
  return out ? /is running/i.test(out) : false;
}

function applyScenario(scenarioId, cb) {
  const sc = SCENARIOS.find(s => s.id === scenarioId);
  if (!sc) return cb(new Error('unknown scenario'));
  const doAdd = () => {
    const file = path.join(SCEN_DIR, `${sc.id}.whistle.js`);
    const body = `module.exports = { name: ${JSON.stringify(GROUP_NAME)}, groupName: ${JSON.stringify(GROUP_NAME)}, rules: ${JSON.stringify(sc.rules.join('\n'))} };\n`;
    fs.writeFileSync(file, body);
    const out = sh(`w2 add --force ${JSON.stringify(file)} 2>&1`, { timeout: 10000 });
    if (out && /success|ok|成功/i.test(out)) {
      STATE.lastScenario = sc.id; saveState();
      cb(null, out);
    } else if (out) {
      STATE.lastScenario = sc.id; saveState();
      cb(null, out); // w2 输出格式不定，尽力解析；UI 上展示原文
    } else cb(new Error('w2 add 无输出（w2 服务可能未运行）'));
  };
  if (w2Running()) return doAdd();
  // w2 未运行 → 先拉起（后台），稍等再 add
  const child = spawn('w2', ['start'], { detached: true, stdio: 'ignore' });
  child.unref();
  let waited = 0;
  const timer = setInterval(() => {
    waited += 1000;
    if (w2Running() || waited >= 12000) { clearInterval(timer); doAdd(); }
  }, 1000);
}

function w2Action(action, cb) {
  if (action === 'stop') { cb(null, sh('w2 stop 2>&1', { timeout: 10000 }) || 'done'); return; }
  const child = spawn('w2', [action === 'restart' ? 'restart' : 'start'], { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => cb(null, w2Running() ? 'running' : 'pending'), 2500);
}

// ---------------------------------------------------------------- 文件夹浏览与项目扫描

function safeDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'dist', 'build'].includes(e.name))
      .map(e => e.name);
  } catch { return []; }
}
function pkgJson(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } }
function devScriptKey(pkg) {
  const s = (pkg && pkg.scripts) || {};
  for (const k of ['dev', 'dev:local', 'dev:staging', 'start', 'serve', 'dev:h5', 'dev:mp-weixin']) if (s[k]) return k;
  const any = Object.keys(s).find(k => /^dev/.test(k)); // 其他 dev:xxx 形态兜底
  return any || null;
}
function guessPort(dir) {
  for (const f of ['vite.config.ts', 'vite.config.js', 'vue.config.js', 'quasar.conf.js']) {
    try {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = t.match(/port["']?\s*[:=]\s*(\d{2,5})/);
      if (m) return Number(m[1]);
    } catch { /* 下一个 */ }
  }
  return null;
}
function slug(s) { return s.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase(); }
function hasZh(s) { return /[一-鿿]/.test(s); }
// 提取项目的中文说明：package.json description → README 首个含中文的标题/正文行（跳过代码块/链接）
function readZhDesc(dir, pkg) {
  if (pkg && pkg.description && hasZh(pkg.description)) return String(pkg.description).replace(/\s+/g, ' ').slice(0, 80);
  for (const f of ['README.md', 'readme.md', 'README.MD']) {
    let t; try { t = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    let inFence = false;
    for (const raw of t.split('\n').slice(0, 40)) {
      const line = raw.trim();
      if (line.startsWith('```')) { inFence = !inFence; continue; }
      if (inFence || !line) continue;
      if (/^#{1,4}\s+/.test(line) && hasZh(line)) return line.replace(/^#+\s*/, '').replace(/\s+/g, ' ').slice(0, 80);
      if (hasZh(line) && !/^[\[!<|*-]/.test(line) && !/^[-*]\s*\[/.test(line) && !/https?:\/\//.test(line)
          && !/^\d+[.、）)]/.test(line) && !/^(TODO|FIXME|todo)/i.test(line) && line.length > 6) {
        return line.replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').slice(0, 80);
      }
    }
  }
  return null;
}
function pmForDir(cwd) {
  return fs.existsSync(path.join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
    : fs.existsSync(path.join(cwd, 'yarn.lock')) ? 'yarn'
    : fs.existsSync(path.join(cwd, 'package-lock.json')) ? 'npm' : 'npm';
}
// 向上找最近含 lockfile 的祖先目录（项目所在仓库根），最多 4 层
function installRootFor(dir) {
  let d = dir;
  for (let i = 0; i < 4; i++) {
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
    if (['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].some(f => fs.existsSync(path.join(d, f)))) return d;
  }
  return dir;
}

// 生成可直接入库的候选项目定义
function nodeCandidate(dir, root, pkg, label) {
  const key = devScriptKey(pkg); if (!key) return null;
  const zh = readZhDesc(dir, pkg);
  const hasOwnLock = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].some(f => fs.existsSync(path.join(dir, f)));
  const installCwd = hasOwnLock ? dir : installRootFor(dir);
  const pm = hasOwnLock || installCwd !== dir ? pmForDir(installCwd) : pmForDir(dir);
  const rootName = path.basename(root);
  const baseName = pkg.name && pkg.name !== 'workspace' ? pkg.name.split('/').pop() : label;
  // 包名与目录名相同（常见于仓库根）时标成「仓库根」，避免与同名子应用混淆
  const label2 = dir === root ? '仓库根' : (baseName === label ? '仓库根' : label);
  const pkgName = baseName;
  return {
    id: 'u-' + slug(rootName + '-' + label),
    group: '📁 ' + rootName + '（文件夹添加）',
    name: pkgName + ' · ' + label2,
    desc: zh ? (zh + ' ｜ ' + pm + ' run ' + key) : `扫描发现：${pm} run ${key}（来自 package.json，未找到中文说明）`,
    dir,
    install: { cwd: installCwd, cmd: pm, args: ['install'], marker: path.join(installCwd, 'node_modules') },
    start: [{ cmd: pm, args: ['run', key], env: { NODE_OPTIONS: '--openssl-legacy-provider' } }],
    port: guessPort(dir), url: null, scenario: null,
    note: '从文件夹扫描添加；端口未识别时启动后自动嗅探；已自动带 openssl-legacy 兼容（webpack4 老项目需要，vite 不受影响）',
  };
}
// 扫描一个文件夹：受限递归（3 层深，node_modules/dist/.git 已滤），Node & Go
function scanFolder(root) {
  const out = [];
  const seen = new Set();
  const push = c => { if (c && !seen.has(c.dir)) { seen.add(c.dir); out.push(c); } };
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const name of safeDirs(dir)) {
      const d = path.join(dir, name);
      const pkg = pkgJson(d);
      if (pkg) {
        push(nodeCandidate(d, root, pkg, path.relative(root, d) || name));
        walk(d, depth + 1); // monorepo 容器/项目内部仍可能有 apps/*、server 等子项目
      } else {
        walk(d, depth + 1);
        if (fs.existsSync(path.join(d, 'go.mod'))) {
          push({ id: 'u-go-' + slug(path.basename(root) + '-' + name), group: '📁 ' + path.basename(root) + '（文件夹添加）',
            name: name + ' · Go', desc: '扫描发现：go.mod', dir: d, install: null,
            start: [{ cmd: 'go', args: ['run', '.'] }], port: null, url: null, scenario: null,
            note: 'Go 项目默认 go run .；入口/main 位置不对请改 custom-projects.json' });
        }
      }
    }
  };
  const rootPkg = pkgJson(root);
  if (rootPkg) push(nodeCandidate(root, root, rootPkg, path.basename(root)));
  walk(root, 1);
  // 已收录（内置 + 自定义）的标记出来：不隐藏，交由 UI 折叠展示
  return out.map(c => {
    c.already = PROJECTS.some(p => p.dir === c.dir);
    return c;
  });
}

// 归属甄别：state 里记录的该启动器进程树曾监听过哪些端口（写入 sniffPort 成功时），
// 避免多项目同端口时把别人的端口贴到自己卡片上
function rememberPortFor(id, port) {
  if (!id || !port) return;
  STATE.ports = STATE.ports || {};
  STATE.ports[id] = STATE.ports[id] || [];
  if (!STATE.ports[id].includes(port)) { STATE.ports[id].push(port); saveState(); }
}
function preferredPort(proj) {
  const hist = (STATE.ports || {})[proj.id];
  if (!hist || !hist.length) return null;
  const alive = hist.find(p => portPids(p).some(pid => {
    // 本启动器记录的进程还活着且监听该端口 → 归属可信
    return (STATE.procs[proj.id] || []).some(r => String(r.pid) === String(pid));
  }));
  if (alive) return alive;
  return null;
}

// 探活：GET 探测（HEAD 兼容性差），拿到状态码立刻断开不读 body；<500 视为服务在（404/405 只是路由问题）
const probeCache = new Map();
function probeUrl(u, cb) {
  const now = Date.now();
  const c = probeCache.get(u);
  if (c && now - c.t < 5000) return cb(c.ok);
  let target; try { target = new url.URL(u); } catch { return cb(false); }
  if (target.hostname === 'localhost') target.hostname = '127.0.0.1'; // node 17+ localhost 优先 IPv6，本地服务多为 IPv4 监听
  const lib = target.protocol === 'https:' ? https : http;
  const req = lib.request(target.href, { method: 'GET', timeout: 3000, rejectUnauthorized: false }, r => {
    const ok = r.statusCode < 500;
    req.destroy();
    probeCache.set(u, { t: Date.now(), ok }); cb(ok);
  });
  req.on('timeout', () => { req.destroy(); probeCache.set(u, { t: Date.now(), ok: false }); cb(false); });
  req.on('error', () => { probeCache.set(u, { t: Date.now(), ok: false }); cb(false); });
  req.end();
}


function projectStatus(proj) {
  const recs = STATE.procs[proj.id] || [];
  const ours = recs.filter(r => pidAlive(r.pid));
  const port = proj.port || preferredPort(proj) || sniffPort(proj.id, null);
  if (port && !proj.port) rememberPortFor(proj.id, port);
  const listeners = port ? portPids(port) : [];
  let status;
  if (ours.length > 0) status = 'running';
  else if (listeners.length > 0) status = 'external';
  else if (recs.length > 0 && Date.now() - Math.max(...recs.map(r => r.startedAt || 0)) < 90000) status = 'starting'; // 启动后 90s 内（进程编译/拉起中）
  else status = 'stopped';
  const installNeed = proj.install ? !fs.existsSync(proj.install.marker) : false;
  const installing = STATE.installing && STATE.installing[proj.id] && !STATE.installing[proj.id].done;
  // 访问地址：显式配置的 url（staging 域名）随时可用；localhost 类地址仅运行/启动中提供
  //（停止态只显示「曾用 :端口」徽标，不给可点链接——避免端口被其他项目占用时误导）
  const live = status === 'running' || status === 'starting' || status === 'external';
  const url = proj.url || (live && port ? (proj.localUrl || `http://localhost:${port}`) : null);
  // 探活（异步缓存，读现值；无缓存则后台发起，下一轮轮询可见）
  let urlOk = null;
  if (url && status === 'running') {
    const c = probeCache.get(url);
    if (c) urlOk = c.ok;
    else setImmediate(() => probeUrl(url, () => { }));
  }
  return {
    id: proj.id, group: proj.group, name: proj.name, desc: proj.desc, note: proj.note || '',
    status, pid: ours.map(r => r.pid), port, url, urlOk,
    scenario: proj.scenario, installNeed, installing,
    custom: !proj.builtin,
  };
}

function buildState() {
  return {
    when: Date.now(),
    autoApplyScenario: !!CFG.autoApplyScenario,
    lastScenario: STATE.lastScenario || null,
    scenarios: SCENARIOS.map(s => ({ id: s.id, name: s.name, desc: s.desc })),
    projects: PROJECTS.map(projectStatus),
    removed: loadRemoved().map(id => ({ id, name: (loadLocal().find(p => p.id === id) || {}).name || id })),
    dataDir: DATA_DIR,
  };
}

function buildEnv() {
  const which = (c) => !!sh(`which ${c}`);
  return {
    node: sh('node -v'),
    pnpm: which('pnpm'), yarn: which('yarn'), led: which('led'), w2: which('w2'),
    w2Running: w2Running(),
    w2Panel: 'http://127.0.0.1:8899/',
    ledPlatform: 'https://led.corp.kuaishou.com',
  };
}

// ---------------------------------------------------------------- HTTP

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, cb) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(raw || '{}')); } catch { cb({}); } });
}

// 存量卡片升级：desc 仍是「扫描发现」占位的，重算中文说明并回写
function enrichCustomDescs() {
  const list = loadLocal();
  let dirty = false;
  for (const c of list) {
    if (typeof c.desc === 'string' && c.desc.startsWith('扫描发现') && c.dir) {
      const zh = readZhDesc(c.dir, pkgJson(c.dir));
      if (zh && c.start && c.start[0]) {
        const step = c.start[0];
        const key = (step.args || []).filter(a => a !== 'run').join(' ') || 'dev';
        c.desc = zh + ' ｜ ' + step.cmd + ' run ' + key;
        dirty = true;
      }
    }
  }
  if (dirty) { saveLocal(list); reloadProjects(); }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  // 仅允许本机访问
  const ra = req.socket.remoteAddress || '';
  if (!/^(127\.|::1|::ffff:127\.)/.test(ra)) { res.writeHead(403); res.end('forbidden'); return; }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res);
    return;
  }

  if (req.method === 'GET' && p === '/api/ping') { sendJSON(res, 200, { ok: true, when: Date.now() }); return; }

  if (req.method === 'GET' && p === '/api/state') { sendJSON(res, 200, buildState()); return; }

  if (req.method === 'GET' && p === '/api/env') { sendJSON(res, 200, buildEnv()); return; }

  if (req.method === 'GET' && p === '/api/logs') {
    const id = u.searchParams.get('id');
    const proj = PROJECTS.find(x => x.id === id);
    if (!proj) { sendJSON(res, 404, { error: 'no such project' }); return; }
    const suffix = u.searchParams.get('suffix') || '';
    sendJSON(res, 200, Object.assign({ id }, tailFile(logFileFor(id, suffix))));
    return;
  }

  if (req.method === 'GET' && p === '/api/led') {
    sendJSON(res, 200, { list: sh('led list 2>&1', { timeout: 8000 }) || '(led list 无输出)' });
    return;
  }

  if (req.method === 'GET' && p === '/api/browse') {
    let dir = u.searchParams.get('path') || (process.env.HOME || '/Users');
    if (!fs.existsSync(dir)) { sendJSON(res, 400, { error: '路径不存在：' + dir }); return; }
    const dirs = safeDirs(dir).map(name => {
      const full = path.join(dir, name);
      const pkg = pkgJson(full);
      return { name, path: full, isProject: (pkg && !!devScriptKey(pkg)) || fs.existsSync(path.join(full, 'go.mod')) };
    });
    sendJSON(res, 200, { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), dirs });
    return;
  }

  if (req.method === 'GET' && p === '/api/scan') {
    const dir = u.searchParams.get('path');
    if (!dir || !fs.existsSync(dir)) { sendJSON(res, 400, { error: '路径不存在：' + dir }); return; }
    const found = scanFolder(dir);
    sendJSON(res, 200, {
      path: dir,
      candidates: found.filter(c => !c.already),
      existing: found.filter(c => c.already),
    });
    return;
  }

  if (req.method === 'POST' && p === '/api/adopt') {
    readBody(req, body => {
      const list = (body.projects || []).filter(c => c && c.dir && c.id);
      const cur = loadLocal();
      let added = 0;
      for (const c of list) {
        if (cur.some(x => x.dir === c.dir)) continue;
        delete c.already; // 扫描期的临时标记不入库
        cur.push(c); added++;
      }
      saveLocal(cur); reloadProjects();
      sendJSON(res, 200, { ok: true, added });
    });
    return;
  }

  if (req.method === 'POST' && p === '/api/clone') {
    readBody(req, body => {
      const url = String(body.url || '').trim();
      if (!/^(git@[^:]+:|https?:\/\/)/.test(url)) { sendJSON(res, 400, { error: '不是有效的 git 地址（支持 git@host:owner/repo.git 或 https://…）' }); return; }
      if (!sh('which git')) { sendJSON(res, 500, { error: '本机未安装 git' }); return; }
      let parent = String(body.parent || '').trim() || path.join(process.env.HOME || '/tmp', 'Documents');
      if (!fs.existsSync(parent)) {
        try { fs.mkdirSync(parent, { recursive: true }); } catch { sendJSON(res, 400, { error: '目标父目录无法创建：' + parent }); return; }
      }
      const name = url.replace(/\/+$/, '').split(/[:/]/).pop().replace(/\.git$/, '') || 'repo';
      const dest = path.join(parent, name);
      if (fs.existsSync(dest)) { sendJSON(res, 409, { error: '目录已存在：' + dest, existing: true, dest }); return; }
      const id = 'clone-' + slug(name) + '-' + Date.now().toString(36);
      const fd = fs.openSync(logFileFor(id), 'a');
      fs.writeSync(fd, `\n===== [${new Date().toLocaleString()}] git clone ${url} → ${dest} =====\n`);
      const child = spawn('git', ['clone', url, dest], { detached: true, stdio: ['ignore', fd, fd] });
      child.unref(); fs.closeSync(fd, () => {});
      STATE.cloning = STATE.cloning || {};
      STATE.cloning[id] = { pid: child.pid, url, dest, startedAt: Date.now(), done: false };
      saveState();
      child.on('exit', code => {
        const rec = STATE.cloning[id]; if (!rec) return;
        rec.done = true; rec.code = code; rec.finishedAt = Date.now(); saveState();
      });
      sendJSON(res, 200, { ok: true, id, dest });
    });
    return;
  }

  if (req.method === 'GET' && p === '/api/clone/status') {
    const list = Object.entries(STATE.cloning || {}).map(([id, c]) => ({
      id, url: c.url, dest: c.dest,
      running: !c.done && pidAlive(c.pid),
      code: c.done ? c.code : null,
      ageSec: Math.round((Date.now() - c.startedAt) / 1000),
    })).filter(c => c.running || (Date.now() - ((STATE.cloning[c.id] || {}).finishedAt || 0)) < 600000);
    sendJSON(res, 200, { ok: true, clones: list });
    return;
  }

  if (req.method === 'POST' && p === '/api/custom/delete') {
    readBody(req, body => {
      if (!body.id) { sendJSON(res, 400, { error: 'missing id' }); return; }
      stopProject(body.id); // 运行中先停
      const all = loadLocal();
      const proj = all.find(x => x.id === body.id);
      if (proj && proj.builtin) {
        const r = loadRemoved();
        if (!r.includes(body.id)) { r.push(body.id); saveRemoved(r); }
      } else {
        saveLocal(all.filter(x => x.id !== body.id));
      }
      reloadProjects();
      sendJSON(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && p === '/api/custom/restore') {
    readBody(req, body => {
      saveRemoved(loadRemoved().filter(x => x !== body.id));
      reloadProjects();
      sendJSON(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && p === '/api/start') {
    readBody(req, body => startProject(body.id, (err, out) =>
      sendJSON(res, err ? 500 : 200, err ? { error: String(err.message || err) } : Object.assign({ ok: true }, out))));
    return;
  }

  if (req.method === 'POST' && p === '/api/stop') {
    readBody(req, body => { stopProject(body.id); sendJSON(res, 200, { ok: true }); });
    return;
  }

  if (req.method === 'POST' && p === '/api/install') {
    readBody(req, body => installProject(body.id, (err, out) =>
      sendJSON(res, err ? 500 : 200, err ? { error: String(err.message || err) } : Object.assign({ ok: true }, out))));
    return;
  }

  if (req.method === 'POST' && p === '/api/w2') {
    readBody(req, body => w2Action(body.action || 'start', (err, out) =>
      sendJSON(res, 200, { ok: !err, out: String(out) })));
    return;
  }

  if (req.method === 'POST' && p === '/api/scenario') {
    readBody(req, body => applyScenario(body.id, (err, out) =>
      sendJSON(res, err ? 500 : 200, err ? { error: String(err.message || err), out: String(out || '') } : { ok: true, out: String(out) })));
    return;
  }

  res.writeHead(404); res.end('not found');
});

let PORT = Number(process.env.LAUNCHER_PORT || 7877);
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && PORT < 7890) {
    PORT += 1;
    console.log(`[dev-launcher] 端口被占，改用 ${PORT}`);
    server.listen(PORT, '127.0.0.1');
  } else {
    console.error('[dev-launcher] 启动失败:', err);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  try { fs.writeFileSync(PORT_FILE, String(PORT)); } catch { }
  enrichCustomDescs(); // 启动时升级存量卡片的中文说明
  console.log(`[dev-launcher] http://127.0.0.1:${PORT}  （Ctrl+C 退出面板服务；已启动的项目不受影响）`);
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_IGNORES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next',
  '.cache', 'outputs', 'work', '.loom'
]);
const SECRET_NAMES = /(^|[._-])(env|secret|secrets|token|password|passwd|credential|credentials)([._-]|$)|id_rsa|\.pem$/i;
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.css', '.html', '.yml', '.yaml', '.toml', '.py', '.go', '.rs', '.java', '.rb', '.sql', '.sh', '.ps1']);

export async function collectWorkspaceContext(cwd = process.cwd(), options = {}) {
  const workspaceRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const maxFiles = options.maxFiles ?? 180;
  const maxBytes = options.maxBytes ?? 18000;
  const maxExcerptBytes = options.maxExcerptBytes ?? 2400;
  const entries = [];
  const excerpts = [];
  const seenFiles = new Set();
  const ignoreRules = await readIgnoreRules(workspaceRoot);
  let totalBytes = 0;

  async function captureFile(fullPath, relative, depth) {
    if (seenFiles.has(fullPath) || entries.length >= maxFiles) return;
    seenFiles.add(fullPath);
    let stat;
    try { stat = await fs.stat(fullPath); } catch { return; }
    if (!stat.isFile()) return;
    entries.push(`${relative.replaceAll('\\', '/')}  ${formatBytes(stat.size)}`);
    const extension = path.extname(relative).toLowerCase();
    const shouldExcerpt = TEXT_EXTENSIONS.has(extension) && totalBytes < maxBytes && (depth <= 1 || excerpts.length < 8);
    if (!shouldExcerpt) return;
    try {
      const buffer = await fs.readFile(fullPath);
      if (buffer.includes(0)) return;
     const excerpt = redactSecrets(buffer.toString('utf8', 0, Math.min(buffer.length, maxExcerptBytes)).trim());
     const remaining = maxBytes - totalBytes;
     if (excerpt && remaining > 80) {
        const clipped = clipUtf8(excerpt, remaining);
        const clippedBytes = Buffer.byteLength(clipped, 'utf8');
        excerpts.push({ path: relative.replaceAll('\\', '/'), text: clipped, truncated: buffer.length > clippedBytes || clipped.length < excerpt.length });
        totalBytes += clippedBytes;
     }
    } catch { /* A single unreadable file should not block the mission. */ }
  }

  for (const requested of Array.isArray(options.include) ? options.include : []) {
    const requestedPath = path.resolve(cwd, requested);
    const fullPath = await fs.realpath(requestedPath).catch(() => null);
    if (!fullPath) continue;
    const relative = path.relative(workspaceRoot, fullPath);
    const outsideWorkspace = !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    const parts = relative.split(path.sep);
    const unsafePart = parts.some((part) => part.startsWith('.') || DEFAULT_IGNORES.has(part) || SECRET_NAMES.test(part));
    if (outsideWorkspace || unsafePart) continue;
    await captureFile(fullPath, relative, relative.split(path.sep).length - 1);
  }

  async function visit(directory, depth) {
    if (depth > (options.maxDepth ?? 3) || entries.length >= maxFiles) return;
    let children;
    try { children = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (entries.length >= maxFiles) break;
      if (child.name.startsWith('.') && child.name !== '.github') continue;
      if (DEFAULT_IGNORES.has(child.name) || SECRET_NAMES.test(child.name)) continue;
      const fullPath = path.join(directory, child.name);
      const relative = path.relative(cwd, fullPath) || child.name;
      const ignored = isIgnored(relative, child.isDirectory(), ignoreRules);
      if (ignored && !(child.isDirectory() && hasNegatedDescendant(relative, ignoreRules))) continue;
      if (child.isDirectory()) {
        if (!ignored) entries.push(`${relative.replaceAll('\\', '/')}/`);
       await visit(fullPath, depth + 1);
        continue;
      }
      if (!child.isFile()) continue;
      await captureFile(fullPath, relative, depth);
    }
  }

  await visit(cwd, 0);
  const git = await readGitSnapshot(cwd, options.includeDiff === true);
  return { cwd, entries, excerpts, fileCount: entries.filter((entry) => !entry.endsWith('/')).length, truncated: entries.length >= maxFiles, git };
}

export function formatWorkspaceContext(context) {
  if (!context || (!context.entries?.length && !context.excerpts?.length)) return 'Workspace context: empty or unavailable.';
  const tree = context.entries.slice(0, 140).join('\n');
  const samples = context.excerpts.map((item) => `--- ${item.path}${item.truncated ? ' (excerpt)' : ''}\n${item.text}`).join('\n\n');
  const git = context.git ? `\n\nGit snapshot:\n${context.git.status || 'clean'}${context.git.diffStat ? `\n${context.git.diffStat}` : ''}${context.git.diff ? `\n\nBounded diff excerpt:\n${context.git.diff}` : ''}` : '';
  return `Workspace project context\nFiles discovered: ${context.fileCount}${context.truncated ? ' (tree capped)' : ''}${git}\n\nProject map:\n${tree}${samples ? `\n\nSelected file excerpts:\n${samples}` : ''}`;
}

function clipUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return text.slice(0, end);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function redactSecrets(text) {
  return text.replace(/((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret)["']?\s*[=:]\s*["']?)([^\s"'`,}]+)/gi, '$1[redacted]');
}

async function readIgnoreRules(cwd) {
  let source;
  try { source = await fs.readFile(path.join(cwd, '.gitignore'), 'utf8'); } catch { return []; }
  return source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((pattern) => {
    const negate = pattern.startsWith('!');
    const value = (negate ? pattern.slice(1) : pattern).replaceAll('\\', '/');
    return { negate, directoryOnly: value.endsWith('/'), pattern: value.replace(/^\//, '').replace(/\/$/, ''), regex: ignorePatternRegex(value.replace(/\/$/, '')) };
  });
}

function isIgnored(relative, directory, rules) {
  const normalized = relative.replaceAll('\\', '/');
  let ignored = false;
  const prefixes = normalized.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  for (const rule of rules) {
    const matches = rule.regex.test(normalized) || (rule.directoryOnly && prefixes.slice(0, -1).some((prefix) => rule.regex.test(prefix)));
    if (matches) ignored = !rule.negate;
  }
  return ignored;
}

function hasNegatedDescendant(relative, rules) {
  const normalized = relative.replaceAll('\\', '/').replace(/\/$/, '');
  const prefix = `${normalized}/`;
  return rules.some((rule) => rule.negate && (rule.pattern.startsWith(prefix) || !rule.pattern.includes('/')));
}

function ignorePatternRegex(pattern) {
  const basename = !pattern.startsWith('/') && !pattern.includes('/');
  const body = pattern.replace(/^\//, '').split(/(\*\*|\*|\?)/).map((part) => part === '*' || part === '**' ? '.*' : part === '?' ? '.' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(basename ? `(^|/)${body}$` : `^${body}$`);
}

async function readGitSnapshot(cwd, includeDiff = false) {
  try {
    const statusResult = await execFileAsync('git', ['status', '--short', '--branch'], { cwd, timeout: 3000, windowsHide: true, maxBuffer: 20000 });
    let diffStat = '';
    try {
      const diffResult = await execFileAsync('git', ['diff', 'HEAD', '--stat'], { cwd, timeout: 3000, windowsHide: true, maxBuffer: 20000 });
      diffStat = diffResult.stdout.trim();
    } catch {
      try {
        const diffResult = await execFileAsync('git', ['diff', '--stat'], { cwd, timeout: 3000, windowsHide: true, maxBuffer: 20000 });
        diffStat = diffResult.stdout.trim();
      } catch { /* A repository can be readable even when its diff is unavailable. */ }
    }
    let diff = '';
    if (includeDiff) {
      try {
        const diffResult = await execFileAsync('git', ['diff', 'HEAD', '--no-ext-diff', '--unified=2'], { cwd, timeout: 3000, windowsHide: true, maxBuffer: 30000 });
        diff = redactSecrets(diffResult.stdout.trim().slice(0, 12000));
      } catch {
        try {
          const diffResult = await execFileAsync('git', ['diff', '--no-ext-diff', '--unified=2'], { cwd, timeout: 3000, windowsHide: true, maxBuffer: 30000 });
          diff = redactSecrets(diffResult.stdout.trim().slice(0, 12000));
        } catch { /* A diff is optional context; status and stats remain useful without it. */ }
      }
    }
    return { status: statusResult.stdout.trim(), diffStat, diff };
  } catch { return null; }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_IGNORES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next',
  '.cache', 'outputs', 'work', '.merge-room'
]);
const SECRET_NAMES = /(^|[._-])(env|secret|secrets|token|password|passwd|credential|credentials)([._-]|$)|id_rsa|\.pem$/i;
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.css', '.html', '.yml', '.yaml', '.toml', '.py', '.go', '.rs', '.java', '.rb', '.sql', '.sh', '.ps1']);
const MAX_IGNORE_FILE_BYTES = 256 * 1024;

export async function collectWorkspaceContext(cwd = process.cwd(), options = {}) {
  ensureActive(options.signal);
  const workspaceRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const maxFiles = options.maxFiles ?? 180;
  const maxBytes = options.maxBytes ?? 18000;
  const maxExcerptBytes = options.maxExcerptBytes ?? 2400;
  const entries = [];
  const excerpts = [];
  const seenFiles = new Set();
  const seenDirectories = new Set();
  const ignoreRules = await readIgnoreRules(workspaceRoot, '', options.signal);
  let totalBytes = 0;

  async function captureFile(fullPath, relative, depth) {
    ensureActive(options.signal);
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
      const handle = await fs.open(fullPath, 'r');
      let buffer;
      let bytesRead;
      try {
        buffer = Buffer.alloc(maxExcerptBytes);
        ({ bytesRead } = await handle.read(buffer, 0, maxExcerptBytes, 0));
      } finally { await handle.close(); }
      buffer = buffer.subarray(0, bytesRead);
      if (buffer.includes(0)) return;
     const excerpt = redactSecrets(buffer.toString('utf8').trim());
     const remaining = maxBytes - totalBytes;
     if (excerpt && remaining > 80) {
        const clipped = clipUtf8(excerpt, remaining);
        const clippedBytes = Buffer.byteLength(clipped, 'utf8');
        excerpts.push({ path: relative.replaceAll('\\', '/'), text: clipped, truncated: stat.size > clippedBytes || clipped.length < excerpt.length });
        totalBytes += clippedBytes;
     }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      /* A single unreadable file should not block the mission. */
    }
  }

  for (const requested of Array.isArray(options.include) ? options.include : []) {
    ensureActive(options.signal);
    const requestedPath = path.resolve(cwd, requested);
    const fullPath = await fs.realpath(requestedPath).catch(() => null);
    if (!fullPath) continue;
    const relative = path.relative(workspaceRoot, fullPath);
    const outsideWorkspace = !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    const parts = relative.split(path.sep);
    const unsafePart = parts.some((part) => part.startsWith('.') || DEFAULT_IGNORES.has(part) || SECRET_NAMES.test(part));
    if (outsideWorkspace || unsafePart) continue;
    let stat;
    try { stat = await fs.stat(fullPath); } catch { continue; }
    if (stat.isDirectory()) {
      const requestedRules = await readIgnoreRulesForPath(workspaceRoot, fullPath, options.signal);
      const ignored = isIgnored(relative, requestedRules, true);
      if (!ignored || hasNegatedDescendant(relative, requestedRules)) await visit(fullPath, 0, requestedRules);
    }
    else if (stat.isFile()) await captureFile(fullPath, relative, relative.split(path.sep).length - 1);
  }

  async function visit(directory, depth, inheritedIgnoreRules = ignoreRules) {
    ensureActive(options.signal);
    if (seenDirectories.has(directory)) return;
    seenDirectories.add(directory);
    if (depth > (options.maxDepth ?? 3) || entries.length >= maxFiles) return;
    const directoryRules = directory === workspaceRoot
      ? inheritedIgnoreRules
      : inheritedIgnoreRules.concat(await readIgnoreRules(directory, path.relative(workspaceRoot, directory), options.signal));
    let children;
    try { children = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      ensureActive(options.signal);
      if (entries.length >= maxFiles) break;
      if (child.name.startsWith('.') && child.name !== '.github') continue;
      if (DEFAULT_IGNORES.has(child.name) || SECRET_NAMES.test(child.name)) continue;
      const fullPath = path.join(directory, child.name);
      const relative = path.relative(workspaceRoot, fullPath) || child.name;
      const ignored = isIgnored(relative, directoryRules, child.isDirectory());
      if (ignored && !(child.isDirectory() && hasNegatedDescendant(relative, directoryRules))) continue;
      if (child.isDirectory()) {
        if (!ignored) entries.push(`${relative.replaceAll('\\', '/')}/`);
        await visit(fullPath, depth + 1, directoryRules);
        continue;
      }
      if (!child.isFile()) continue;
      await captureFile(fullPath, relative, depth);
    }
  }

  await visit(workspaceRoot, 0, ignoreRules);
  const git = await readGitSnapshot(cwd, options.includeDiff === true, options.signal);
  ensureActive(options.signal);
  return { cwd, entries, excerpts, fileCount: entries.filter((entry) => !entry.endsWith('/')).length, truncated: entries.length >= maxFiles, git };
}

function ensureActive(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Mission cancelled.');
  error.name = 'AbortError';
  throw error;
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
  const lines = text.split(/(\r\n|\n|\r)/);
  const unifiedDiff = /^(?:diff --git |@@ )/m.test(text);
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const diffPrefix = unifiedDiff && /^[ +\-]/.test(line) ? line[0] : '';
    const contentLine = diffPrefix ? line.slice(1) : line;
    const match = /(\bauthorization\b["']?\s*[:=]\s*)(.*)$/i.exec(contentLine);
    if (!match) continue;
    lines[index] = `${diffPrefix}${contentLine.slice(0, match.index)}${match[1]}[redacted]`;
    if (!/^[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/.test(match[2].trim())) continue;
    const baseIndent = (contentLine.match(/^[ \t]*/) || [''])[0].length;
    for (let continuation = index + 2; continuation < lines.length; continuation += 2) {
      const valueLine = lines[continuation];
      const valuePrefix = unifiedDiff && /^[ +\-]/.test(valueLine) ? valueLine[0] : '';
      const valueContent = valuePrefix ? valueLine.slice(1) : valueLine;
      if (/^[ \t]*$/.test(valueContent)) continue;
      const indent = (valueContent.match(/^[ \t]*/) || [''])[0].length;
      if (indent <= baseIndent) break;
      lines[continuation] = `${valuePrefix}${valueContent.slice(0, indent)}[redacted]`;
    }
  }
  const withAuthorizationHeadersRedacted = lines.join('');
  const withAuthSchemeCredentialsRedacted = withAuthorizationHeadersRedacted.replace(/\b((?:Bearer|Basic|Token|Digest|HOBA|Mutual|Negotiate|OAuth|SCRAM(?:-[A-Z0-9-]+)?|VAPID|AWS4-HMAC-SHA256|Signature|DPoP)\s+)(?![=:])[^\r\n]*/gi, '$1[redacted]');
  return withAuthSchemeCredentialsRedacted.replace(/((?:api[_-]?key|(?:api|access|refresh|id|auth|session|provider)[_-]?token|token|auth|password|passwd|secret)["']?\s*[=:]\s*["']?)([^\s"'`,}]+)/gi, '$1[redacted]');
}

async function readIgnoreRules(cwd, base = '', signal) {
  ensureActive(signal);
  const normalizedBase = base.replaceAll('\\', '/').replace(/^\.\/$/, '');
  const ignoreFile = path.join(cwd, '.gitignore');
  let handle;
  let source;
  try {
    handle = await fs.open(ignoreFile, 'r');
    const stat = await handle.stat();
    if (stat.size > MAX_IGNORE_FILE_BYTES) return [ignoreEverythingRule(normalizedBase)];
    const buffer = Buffer.alloc(MAX_IGNORE_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    ensureActive(signal);
    if (bytesRead > MAX_IGNORE_FILE_BYTES) return [ignoreEverythingRule(normalizedBase)];
    source = buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if (error.name === 'AbortError' || signal?.aborted) ensureActive(signal);
    if (error.code === 'ENOENT') return [];
    return [ignoreEverythingRule(normalizedBase)];
  } finally {
    await handle?.close().catch(() => {});
  }
  ensureActive(signal);
  return source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((rawPattern) => {
    const negate = rawPattern.startsWith('!');
    const value = (negate ? rawPattern.slice(1) : rawPattern).replaceAll('\\', '/');
    const anchored = value.startsWith('/');
    const pattern = value.replace(/^\//, '').replace(/\/$/, '');
    return { negate, base: normalizedBase, directoryOnly: value.endsWith('/'), pattern, regex: ignorePatternRegex(pattern, !anchored) };
  });
}

function ignoreEverythingRule(base) {
  return { negate: false, base, directoryOnly: false, pattern: '**', regex: /^[\s\S]*$/ };
}

async function readIgnoreRulesForPath(workspaceRoot, targetPath, signal, cache = new Map()) {
  const targetDirectory = path.dirname(targetPath);
  const relative = path.relative(workspaceRoot, targetDirectory);
  const directories = [workspaceRoot];
  if (relative && relative !== '.') {
    let current = workspaceRoot;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      directories.push(current);
    }
  }
  const rules = [];
  for (const directory of directories) {
    ensureActive(signal);
    const base = path.relative(workspaceRoot, directory);
    const key = path.resolve(directory);
    let directoryRules = cache.get(key);
    if (!directoryRules) {
      directoryRules = await readIgnoreRules(directory, base, signal);
      cache.set(key, directoryRules);
    }
    rules.push(...directoryRules);
  }
  return rules;
}

function isIgnored(relative, rules, directory = false) {
  const normalized = relative.replaceAll('\\', '/');
  const parts = normalized.split('/');
  for (let end = 1; end < parts.length; end += 1) {
    if (matchesIgnoreRules(parts.slice(0, end).join('/'), rules, true)) return true;
  }
  return matchesIgnoreRules(normalized, rules, directory);
}

function matchesIgnoreRules(normalized, rules, directory) {
  let ignored = false;
  for (const rule of rules) {
    const scopedPath = rule.base
      ? normalized.startsWith(`${rule.base}/`) ? normalized.slice(rule.base.length + 1) : null
      : normalized;
    if (scopedPath === null) continue;
    const matches = (!rule.directoryOnly || directory) && rule.regex.test(scopedPath);
    if (matches) ignored = !rule.negate;
  }
  return ignored;
}

function hasNegatedDescendant(relative, rules) {
  const normalized = relative.replaceAll('\\', '/').replace(/\/$/, '');
  const prefix = `${normalized}/`;
  return rules.some((rule) => {
    if (!rule.negate) return false;
    const base = rule.base;
    if (base && normalized !== base && !normalized.startsWith(`${base}/`) && !base.startsWith(`${normalized}/`)) return false;
    const effectivePattern = [base, rule.pattern].filter(Boolean).join('/');
    return effectivePattern.startsWith(prefix)
      || (rule.pattern.includes('/') && /[*?]/.test(rule.pattern));
  });
}

function ignorePatternRegex(pattern, matchBasename = !pattern.includes('/')) {
  const body = pattern.replace(/^\//, '').split(/(\*\*\/|\*\*|\*|\?)/).map((part) => part === '**/' ? '(?:.*/)?' : part === '*' || part === '**' ? '.*' : part === '?' ? '.' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(matchBasename ? `(^|/)${body}$` : `^${body}$`);
}

async function readGitSnapshot(cwd, includeDiff = false, signal) {
  try {
    const statusResult = await execFileAsync('git', ['status', '--short', '--branch', '--untracked-files=all', '-z'], { cwd, signal, timeout: 3000, windowsHide: true, maxBuffer: 30000 });
    const status = await filterGitStatus(cwd, statusResult.stdout, signal);
    let diffStat = '';
    let changedPaths = [];
    let diffBase = 'HEAD';
    try {
      const pathsResult = await execFileAsync('git', ['diff', 'HEAD', '--name-only', '-z', '--no-renames'], { cwd, signal, timeout: 3000, windowsHide: true, maxBuffer: 30000 });
      changedPaths = pathsResult.stdout.split('\0').filter(Boolean);
    } catch {
      diffBase = null;
      try {
        const pathsResult = await execFileAsync('git', ['diff', '--name-only', '-z', '--no-renames'], { cwd, signal, timeout: 3000, windowsHide: true, maxBuffer: 30000 });
        changedPaths = pathsResult.stdout.split('\0').filter(Boolean);
      } catch { /* A repository can be readable even when its diff is unavailable. */ }
    }
    ensureActive(signal);
    const pathArgs = [];
    const ignoreRuleCache = new Map();
    let pathArgsBytes = 0;
    for (const relative of changedPaths) {
      ensureActive(signal);
      const normalized = relative.replaceAll('\\', '/').replace(/^\.\//, '');
      if (!isSafeDiffPath(normalized)) continue;
      const ignoreRules = await readIgnoreRulesForPath(cwd, path.resolve(cwd, relative), signal, ignoreRuleCache);
      if (isIgnored(normalized, ignoreRules)) continue;
      const argument = `:(literal)${relative}`;
      const argumentBytes = Buffer.byteLength(argument, 'utf8') + 1;
      if (pathArgs.length >= 256 || pathArgsBytes + argumentBytes > 12000) break;
      pathArgs.push(argument);
      pathArgsBytes += argumentBytes;
    }
    if (pathArgs.length) {
      try {
        diffStat = await getDiffStat(cwd, diffBase, pathArgs, signal);
      } catch { /* A diff is optional context; status remains useful without it. */ }
    }
    let diff = '';
    if (includeDiff && pathArgs.length) {
      try {
        const diffArgs = ['diff', ...(diffBase ? [diffBase] : []), '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=2', '--', ...pathArgs];
        const diffResult = await execFileAsync('git', diffArgs, { cwd, signal, timeout: 3000, windowsHide: true, maxBuffer: 30000 });
        diff = redactSecrets(diffResult.stdout.trim().slice(0, 12000));
      } catch { /* A diff is optional context; status and stats remain useful without it. */ }
    }
    return { status, diffStat, diff };
  } catch (error) {
    if (error.name === 'AbortError' || signal?.aborted) ensureActive(signal);
    return null;
  }
}

async function getDiffStat(cwd, base, pathArgs, signal) {
  try {
    const args = ['diff', ...(base ? [base] : []), '--stat', '--no-ext-diff', '--no-textconv', '--no-renames', '--', ...pathArgs];
    const result = await execFileAsync('git', args, { cwd, signal, timeout: 3000, windowsHide: true, maxBuffer: 20000 });
    return result.stdout.trim();
  } catch (error) {
    if (error.name === 'AbortError' || signal?.aborted) ensureActive(signal);
    return '';
  }
}

function isSafeDiffPath(relative) {
  const normalized = relative.replaceAll('\\', '/').replace(/^\.\//, '');
  return isSafeContextPath(normalized) && TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function isSafeContextPath(relative) {
  const parts = relative.split('/');
  return Boolean(relative) && !parts.some((part) => !part || part.startsWith('.') || DEFAULT_IGNORES.has(part) || SECRET_NAMES.test(part));
}

async function filterGitStatus(cwd, rawStatus, signal) {
  const records = rawStatus.split('\0').filter(Boolean);
  const branch = records.find((record) => record.startsWith('##')) || '';
  const safeEntries = [];
  const ignoreRuleCache = new Map();
  for (let index = 0; index < records.length; index += 1) {
    ensureActive(signal);
    const record = records[index];
    if (record.startsWith('##')) continue;
    const code = record.slice(0, 2);
    const relative = record.slice(2).replace(/^ /, '').replaceAll('\\', '/');
    const rename = code.includes('R') || code.includes('C');
    const source = rename ? records[++index] || '' : '';
    const normalized = relative.replace(/^\.\//, '');
    const normalizedSource = source.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!isSafeContextPath(normalized) || (rename && !isSafeContextPath(normalizedSource))) continue;
    const isDirectory = normalized.endsWith('/');
    const rules = await readIgnoreRulesForPath(cwd, path.resolve(cwd, normalized), signal, ignoreRuleCache);
    if (isIgnored(normalized.replace(/\/$/, ''), rules, isDirectory)) continue;
    const printablePath = relative.replace(/[\u0000-\u001f\u007f]/g, '?');
    safeEntries.push(`${code} ${printablePath}`);
  }
  return [branch, ...safeEntries].filter(Boolean).join('\n').trim();
}

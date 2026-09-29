import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
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
const CONTEXT_TRAVERSAL_BATCH_SIZE = 128;

export async function collectWorkspaceContext(cwd = process.cwd(), options = {}) {
  ensureActive(options.signal);
  const workspaceRoot = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const maxFiles = options.maxFiles ?? 180;
  const maxDepth = options.maxDepth ?? 3;
  // A negated rule can make us walk an ignored tree even when none of its
  // files can be returned. Bound that work separately from the output cap.
  const maxTraversalEntries = Math.max(1, maxFiles) * 20;
  const maxBytes = options.maxBytes ?? 18000;
  const maxExcerptBytes = options.maxExcerptBytes ?? 2400;
  const entries = [];
  const excerpts = [];
  const seenFiles = new Set();
  const seenDirectories = new Set();
  let traversedEntries = 0;
  let bufferedDirents = 0;
  let traversalTruncated = false;
  let outputTruncated = false;
  let stopTraversal = false;
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
    if (stopTraversal || seenDirectories.has(directory)) return;
    seenDirectories.add(directory);
    if (depth > maxDepth) return;
    const directoryRules = directory === workspaceRoot
      ? inheritedIgnoreRules
      : inheritedIgnoreRules.concat(await readIgnoreRules(directory, path.relative(workspaceRoot, directory), options.signal));
    let handle;
    try { handle = await fs.opendir(directory); } catch { return; }
    let directoryEnded = false;
    try {
      while (!directoryEnded && !stopTraversal) {
        ensureActive(options.signal);
        if (entries.length >= maxFiles) {
          if (traversedEntries >= maxTraversalEntries) {
            traversalTruncated = true;
          } else if (bufferedDirents >= CONTEXT_TRAVERSAL_BATCH_SIZE) {
            outputTruncated = true;
            stopTraversal = true;
          } else {
            const next = await handle.read().catch(() => null);
            if (next) {
              traversedEntries += 1;
              bufferedDirents += 1;
              outputTruncated = true;
              bufferedDirents -= 1;
              stopTraversal = true;
            } else {
              directoryEnded = true;
            }
          }
          break;
        }
        if (traversedEntries >= maxTraversalEntries) {
          traversalTruncated = true;
          stopTraversal = true;
          break;
        }

        if (bufferedDirents >= CONTEXT_TRAVERSAL_BATCH_SIZE) {
          traversalTruncated = true;
          stopTraversal = true;
          break;
        }
        const batch = [];
        const remainingLevels = Math.max(1, maxDepth - depth + 1);
        const batchLimit = Math.max(1, Math.floor((CONTEXT_TRAVERSAL_BATCH_SIZE - bufferedDirents) / remainingLevels));
        while (batch.length < batchLimit
          && bufferedDirents < CONTEXT_TRAVERSAL_BATCH_SIZE
          && traversedEntries < maxTraversalEntries) {
          ensureActive(options.signal);
          const child = await handle.read();
          if (!child) {
            directoryEnded = true;
            break;
          }
          batch.push(child);
          traversedEntries += 1;
          bufferedDirents += 1;
        }
        batch.sort((a, b) => a.name.localeCompare(b.name));
        for (let index = 0; index < batch.length; index += 1) {
          const child = batch[index];
          bufferedDirents -= 1;
          ensureActive(options.signal);
          if (entries.length >= maxFiles) {
            outputTruncated = true;
            stopTraversal = true;
            bufferedDirents -= batch.length - index - 1;
            break;
          }
          if (child.name.startsWith('.') && child.name !== '.github') continue;
          if (DEFAULT_IGNORES.has(child.name) || SECRET_NAMES.test(child.name)) continue;
          const fullPath = path.join(directory, child.name);
          const relative = path.relative(workspaceRoot, fullPath) || child.name;
          const ignored = isIgnored(relative, directoryRules, child.isDirectory());
          if (ignored && !(child.isDirectory() && hasNegatedDescendant(relative, directoryRules))) continue;
          if (child.isDirectory()) {
            if (!ignored) entries.push(`${relative.replaceAll('\\', '/')}/`);
            await visit(fullPath, depth + 1, directoryRules);
            if (stopTraversal) break;
            continue;
          }
          if (!child.isFile()) continue;
          await captureFile(fullPath, relative, depth);
        }
        if (traversedEntries >= maxTraversalEntries && !directoryEnded && !stopTraversal) {
          traversalTruncated = true;
          stopTraversal = true;
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  await visit(workspaceRoot, 0, ignoreRules);
  const git = await readGitSnapshot(cwd, options.includeDiff === true, options.signal);
  ensureActive(options.signal);
  return { cwd, entries, excerpts, fileCount: entries.filter((entry) => !entry.endsWith('/')).length, truncated: traversalTruncated || outputTruncated, git };
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
  text = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[redacted]');
  const unifiedDiff = /^(?:diff --git |@@ )/m.test(text);
  text = redactYamlPrivateKeyBlocks(text, unifiedDiff);
  const lines = text.split(/(\r\n|\n|\r)/);
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
  const assignmentPattern = /(^|[^A-Za-z0-9_])((?:[A-Za-z][A-Za-z0-9_-]*[-_])?(?:private[_-]?key(?:[_-]?id)?|api[_-]?key|(?:api|access|refresh|id|auth|session|provider)[_-]?token|token|auth|password|passwd|secret)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\\r\n])*"?|'(?:''|\\.|[^'\\\r\n])*'?|[^\s"'`,}]+)/gi;
  const usageTokenPrefixes = new Set(['input', 'output', 'prompt', 'completion', 'total', 'reasoning', 'cached', 'read', 'write', 'creation']);
  return withAuthSchemeCredentialsRedacted.split(/(\r\n|\n|\r)/).map((line, index) => {
    if (index % 2 === 1) return line;
    const diffPrefix = unifiedDiff && /^[ +\-]/.test(line) ? line[0] : '';
    const contentLine = diffPrefix ? line.slice(1) : line;
    return `${diffPrefix}${contentLine.replace(assignmentPattern, (match, boundary, prefix) => {
      const assignedName = prefix.match(/^([A-Za-z][A-Za-z0-9_-]*)/)?.[1].toLowerCase();
      const usagePrefix = assignedName?.split(/[_-]/)[0];
      if (/(?:^|[-_])token$/.test(assignedName || '') && usageTokenPrefixes.has(usagePrefix)) return match;
      const firstValueChar = match[boundary.length + prefix.length];
      const quote = firstValueChar === '"' || firstValueChar === "'" ? firstValueChar : '';
      return `${boundary}${prefix}${quote}[redacted]${quote}`;
    })}`;
  }).join('');
}

function redactYamlPrivateKeyBlocks(text, unifiedDiff) {
  const lines = text.split(/(\r\n|\n|\r)/);
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const diffPrefix = unifiedDiff && /^[ +\-]/.test(line) ? line[0] : '';
    const content = diffPrefix ? line.slice(1) : line;
    const match = /^([ \t]*(?:-[ \t]*)?private[_-]?key["']?[ \t]*:[ \t]*)(?:\|[+-]?\d*[+-]?|>[+-]?\d*[+-]?)[ \t]*(?:#.*)?$/i.exec(content);
    if (!match) continue;

    const baseIndent = (content.match(/^[ \t]*/) || [''])[0].length;
    lines[index] = `${diffPrefix}${match[1]}[redacted]`;
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
  return lines.join('');
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
  return source.split(/\r?\n/).map((line) => trimUnescapedTrailingSpaces(line.trimStart())).filter((line) => line && !line.startsWith('#')).map((rawPattern) => {
    const negate = rawPattern.startsWith('!');
    const value = negate ? rawPattern.slice(1) : rawPattern;
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
  let body = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\' && index + 1 < pattern.length) {
      body += pattern[++index].replace(/[.*?+^${}()|[\]\\]/g, '\\$&');
    } else if (char === '*' && pattern[index + 1] === '*' && pattern[index + 2] === '/') {
      body += '(?:.*/)?';
      index += 2;
    } else if (char === '*' && pattern[index + 1] === '*') {
      body += '.*';
      index += 1;
    } else if (char === '*') body += '.*';
    else if (char === '?') body += '.';
    else body += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(matchBasename ? `(^|/)${body}$` : `^${body}$`);
}

function trimUnescapedTrailingSpaces(line) {
  let end = line.length;
  while (end > 0 && /\s/.test(line[end - 1])) {
    let slashes = 0;
    for (let index = end - 2; index >= 0 && line[index] === '\\'; index -= 1) slashes += 1;
    if (slashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

async function readGitSnapshot(cwd, includeDiff = false, signal) {
  try {
    const statusResult = await execFileAsync('git', ['status', '--short', '--branch', '--untracked-files=all', '-z'], { cwd, signal, timeout: 3000, windowsHide: true, maxBuffer: 30000 });
    const status = await filterGitStatus(cwd, statusResult.stdout, signal);
    let diffStat = '';
    let changedPaths = [];
    const untrackedPaths = [];
    if (includeDiff) {
      for (const record of statusResult.stdout.split('\0')) {
        if (record.startsWith('?? ')) untrackedPaths.push(record.slice(3));
      }
    }
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
    const untrackedDiffPaths = [];
    for (const relative of untrackedPaths) {
      ensureActive(signal);
      const normalized = relative.replaceAll('\\', '/').replace(/^\.\//, '');
      if (!isSafeDiffPath(normalized)) continue;
      const rules = await readIgnoreRulesForPath(cwd, path.resolve(cwd, relative), signal, ignoreRuleCache);
      if (isIgnored(normalized, rules)) continue;
      if (/[\u0000-\u001f\u007f]/.test(relative)) continue;
      const argument = `:(literal)${relative}`;
      const argumentBytes = Buffer.byteLength(argument, 'utf8') + 1;
      if (pathArgs.length + untrackedDiffPaths.length >= 32 || pathArgsBytes + argumentBytes > 12000) break;
      untrackedDiffPaths.push(relative);
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
        diff = clipUtf8(redactSecrets(diffResult.stdout.trim()), 12000);
      } catch { /* A diff is optional context; status and stats remain useful without it. */ }
    }
    if (includeDiff && untrackedDiffPaths.length && Buffer.byteLength(diff, 'utf8') < 12000) {
      const chunks = diff ? [diff] : [];
      let diffBytes = Buffer.byteLength(diff, 'utf8');
      for (const relative of untrackedDiffPaths) {
        ensureActive(signal);
        if (diffBytes >= 12000) break;
        const remaining = 12000 - diffBytes;
        const content = await readUntrackedFileSafely(cwd, relative, 12000, signal);
        if (!content || content.includes(0)) continue;
        const chunk = formatUntrackedDiff(relative, content, remaining);
        if (!chunk) continue;
        chunks.push(chunk);
        diffBytes += Buffer.byteLength(chunk, 'utf8');
      }
      diff = clipUtf8(redactSecrets(chunks.join('\n').trim()), 12000);
    }
    return { status, diffStat, diff };
  } catch (error) {
    if (error.name === 'AbortError' || signal?.aborted) ensureActive(signal);
    return null;
  }
}

async function readUntrackedFileSafely(cwd, relative, maxBytes, signal) {
  ensureActive(signal);
  const workspaceRoot = await fs.realpath(cwd).catch(() => null);
  if (!workspaceRoot) return null;
  const requestedPath = path.resolve(workspaceRoot, relative);
  const canonicalPath = await fs.realpath(requestedPath).catch(() => null);
  if (!canonicalPath) return null;
  const withinWorkspace = path.relative(workspaceRoot, canonicalPath);
  if (!withinWorkspace || withinWorkspace === '..' || withinWorkspace.startsWith(`..${path.sep}`) || path.isAbsolute(withinWorkspace)) return null;

  let before;
  try { before = await fs.lstat(canonicalPath, { bigint: true }); } catch { return null; }
  if (!before.isFile() || before.isSymbolicLink()) return null;
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await fs.open(canonicalPath, flags);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return null;
    ensureActive(signal);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    ensureActive(signal);
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) ensureActive(signal);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function formatUntrackedDiff(relative, buffer, maxBytes) {
  const filePath = relative.replaceAll('\\', '/');
  const header = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n`;
  if (Buffer.byteLength(header, 'utf8') + 20 >= maxBytes) return '';
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const hasFinalNewline = /(?:\r\n|\n)$/.test(text);
  if (hasFinalNewline) lines.pop();
  else if (!text) lines.length = 0;
  const additions = [];
  let usedBytes = Buffer.byteLength(header, 'utf8') + 32;
  for (const line of lines) {
    const addition = `+${line}\n`;
    const bytes = Buffer.byteLength(addition, 'utf8');
    if (usedBytes + bytes > maxBytes) break;
    additions.push(addition);
    usedBytes += bytes;
  }
  const truncated = buffer.length > 12000 || additions.length < lines.length;
  const marker = truncated ? '+[diff excerpt truncated]\n' : '';
  const noNewlineMarker = !truncated && text.length > 0 && !hasFinalNewline ? '\\ No newline at end of file\n' : '';
  const markerBytes = Buffer.byteLength(marker + noNewlineMarker, 'utf8');
  while (additions.length && usedBytes + markerBytes > maxBytes) {
    usedBytes -= Buffer.byteLength(additions.pop(), 'utf8');
  }
  const addedLines = additions.length + (truncated ? 1 : 0);
  const hunk = addedLines ? `@@ -0,0 +1,${addedLines} @@\n` : '';
  return `${header}${hunk}${additions.join('')}${marker}${noNewlineMarker}`;
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

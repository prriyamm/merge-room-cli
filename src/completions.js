const COMMANDS = ['run', 'ask', 'review', 'brainstorm', 'interactive', 'agents', 'history', 'usage', 'stats', 'config', 'show', 'export', 'resume', 'context', 'doctor', 'init', 'completions', 'version'];
const OPTIONS = ['--help', '--version', '--json', '--no-context', '--no-save', '--parallel', '--diff', '--trace', '--no-stream', '--stream-usage', '--events', '--team=', '--model=', '--base-url=', '--max-tokens=', '--temperature=', '--concurrency=', '--timeout=', '--retries=', '--include=', '--limit=', '--format=', '--output=', '--config='];

export function completionScript(shell = defaultShell()) {
  const normalized = shell.toLowerCase() === 'ps' ? 'powershell' : shell.toLowerCase();
  if (normalized === 'bash') return bashCompletion();
  if (normalized === 'zsh') return zshCompletion();
  if (normalized === 'powershell') return powershellCompletion();
  throw new Error('Supported completion shells: bash, zsh, powershell.');
}

export function defaultShell() {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function bashCompletion() {
  return [
    '# Loom completion for Bash',
    '_loom() {',
    '  local current="${COMP_WORDS[COMP_CWORD]}"',
    '  COMPREPLY=( $(compgen -W "' + COMMANDS.concat(OPTIONS).join(' ') + '" -- "$current") )',
    '}',
    'complete -F _loom loom',
    ''
  ].join('\n');
}

function zshCompletion() {
  return [
    '#compdef loom',
    '_arguments \'1:command:(' + COMMANDS.join(' ') + ')\' \'*:option:(' + OPTIONS.join(' ') + ')\'',
    ''
  ].join('\n');
}

function powershellCompletion() {
  const values = [...COMMANDS, ...OPTIONS].join("', '");
  return [
    '# Loom completion for PowerShell',
    'Register-ArgumentCompleter -CommandName loom -ScriptBlock {',
    '  param($wordToComplete, $commandAst, $cursorPosition)',
    "  $values = @('" + values + "')",
    '  $values | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
    "    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
    '  }',
    '}',
    ''
  ].join('\n');
}

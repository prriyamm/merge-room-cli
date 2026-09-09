const COMMANDS = ['run', 'ask', 'review', 'brainstorm', 'plan', 'interactive', 'agents', 'history', 'usage', 'stats', 'config', 'show', 'export', 'resume', 'context', 'doctor', 'init', 'theme', 'completions', 'version'];
const OPTIONS = ['--help', '--version', '--json', '--no-context', '--no-save', '--parallel', '--diff', '--trace', '--no-stream', '--stream-usage', '--events', '--strict', '--team=', '--provider=', '--model=', '--base-url=', '--max-tokens=', '--temperature=', '--concurrency=', '--max-calls=', '--timeout=', '--retries=', '--run-id=', '--theme=', '--include=', '--limit=', '--format=', '--output=', '--config='];

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
    '# Merge Room completion for Bash',
    '_merge-room() {',
    '  local current="${COMP_WORDS[COMP_CWORD]}"',
    '  COMPREPLY=( $(compgen -W "' + COMMANDS.concat(OPTIONS).join(' ') + '" -- "$current") )',
    '}',
    'complete -F _merge-room merge-room',
    ''
  ].join('\n');
}

function zshCompletion() {
  return [
    '#compdef merge-room',
    '_arguments \'1:command:(' + COMMANDS.join(' ') + ')\' \'*:option:(' + OPTIONS.join(' ') + ')\'',
    ''
  ].join('\n');
}

function powershellCompletion() {
  const values = [...COMMANDS, ...OPTIONS].join("', '");
  return [
    '# Merge Room completion for PowerShell',
    'Register-ArgumentCompleter -CommandName merge-room -ScriptBlock {',
    '  param($wordToComplete, $commandAst, $cursorPosition)',
    "  $values = @('" + values + "')",
    '  $values | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
    "    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
    '  }',
    '}',
    ''
  ].join('\n');
}

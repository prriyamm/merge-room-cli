import { THEMES } from './themes.js';

const COMMANDS = ['run', 'ask', 'review', 'brainstorm', 'plan', 'interactive', 'chat', 'agents', 'providers', 'history', 'usage', 'stats', 'config', 'show', 'export', 'resume', 'context', 'doctor', 'init', 'theme', 'completions', 'completion', 'version', 'help'];
const OPTIONS = ['-h', '-v', '--help', '--version', '--json', '--no-context', '--no-save', '--parallel', '--diff', '--trace', '--no-stream', '--stream-usage', '--events', '--strict', '--cwd', '--cwd=', '-C', '--prompt-file=', '--team=', '--provider=', '--profile=', '--model=', '--base-url=', '--max-tokens=', '--temperature=', '--concurrency=', '--max-calls=', '--timeout=', '--retries=', '--run-id=', '--theme', '--theme=', '--include=', '--limit=', '--format', '--format=', '--output=', '--config='];
const SHELLS = ['bash', 'zsh', 'powershell'];
const THEME_NAMES = [...Object.keys(THEMES), 'list'];
const THEME_VALUES = Object.keys(THEMES);
const FORMAT_VALUES = ['md', 'markdown', 'json'];
const VALUE_CANDIDATES = [
  ...Object.keys(THEMES).map((theme) => `--theme=${theme}`),
  ...FORMAT_VALUES.map((format) => `--format=${format}`)
];

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
  const candidates = COMMANDS.concat(OPTIONS, VALUE_CANDIDATES).join(' ');
  return [
    '# Merge Room completion for Bash',
    '_merge_room() {',
    '  local current="${COMP_WORDS[COMP_CWORD]}"',
    '  local previous="${COMP_WORDS[COMP_CWORD-1]}"',
    '  if [[ "$previous" == "completions" || "$previous" == "completion" ]]; then',
    '    COMPREPLY=( $(compgen -W "' + SHELLS.join(' ') + '" -- "$current") )',
    '  elif [[ "$previous" == "--theme" ]]; then',
    '    COMPREPLY=( $(compgen -W "' + THEME_VALUES.join(' ') + '" -- "$current") )',
    '  elif [[ "$previous" == "--format" ]]; then',
    '    COMPREPLY=( $(compgen -W "' + FORMAT_VALUES.join(' ') + '" -- "$current") )',
    '  elif [[ "$previous" == "theme" ]]; then',
    '    COMPREPLY=( $(compgen -W "' + THEME_NAMES.join(' ') + '" -- "$current") )',
    '  else',
    '    COMPREPLY=( $(compgen -W "' + candidates + '" -- "$current") )',
    '  fi',
    '}',
    'complete -F _merge_room merge-room',
    ''
  ].join('\n');
}

function zshCompletion() {
  return [
    '#compdef merge-room',
    '_merge_room() {',
    '  local -a commands options shells themes formats theme_values',
    '  commands=(' + COMMANDS.join(' ') + ')',
    '  options=(' + OPTIONS.concat(VALUE_CANDIDATES).join(' ') + ')',
    '  shells=(' + SHELLS.join(' ') + ')',
    '  themes=(' + THEME_NAMES.join(' ') + ')',
    '  formats=(' + FORMAT_VALUES.join(' ') + ')',
    '  theme_values=(' + THEME_VALUES.join(' ') + ')',
    '  if (( CURRENT == 2 )) && [[ ${words[CURRENT]} == -* ]]; then',
    '    _describe option options',
    '  elif (( CURRENT == 2 )); then',
    '    _describe command commands',
    '  elif (( CURRENT == 3 )) && [[ ${words[2]} == completions || ${words[2]} == completion ]]; then',
    '    _describe shell shells',
    '  elif (( CURRENT == 3 )) && [[ ${words[2]} == theme ]]; then',
    '    _describe theme themes',
    '  elif [[ ${words[CURRENT-1]} == --theme ]]; then',
    '    _describe theme theme_values',
    '  elif [[ ${words[CURRENT-1]} == --format ]]; then',
    '    _describe format formats',
    '  else',
    '    _describe option options',
    '  fi',
    '}',
    ''
  ].join('\n');
}

function powershellCompletion() {
  const values = [...COMMANDS, ...OPTIONS, ...VALUE_CANDIDATES].join("', '");
  return [
    '# Merge Room completion for PowerShell',
    'Register-ArgumentCompleter -CommandName merge-room -ScriptBlock {',
    '  param($wordToComplete, $commandAst, $cursorPosition)',
    "  $values = @('" + values + "')",
    "  $elements = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })",
    "  if ($elements.Count -gt 1 -and $elements[1] -in @('completions', 'completion')) { $values = @('" + SHELLS.join("', '") + "') }",
    "  elseif ($elements.Count -gt 1 -and $elements[1] -eq 'theme') { $values = @('" + THEME_NAMES.join("', '") + "') }",
    "  elseif ($elements.Count -gt 1 -and $elements[-2] -eq '--theme') { $values = @('" + THEME_VALUES.join("', '") + "') }",
    "  elseif ($elements.Count -gt 1 -and $elements[-2] -eq '--format') { $values = @('" + FORMAT_VALUES.join("', '") + "') }",
    '  $values | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
    "    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
    '  }',
    '}',
    ''
  ].join('\n');
}

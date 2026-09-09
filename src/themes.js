const palette = (values) => Object.freeze({
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  ...Object.fromEntries(Object.entries(values).map(([name, code]) => [name, `\x1b[${code}m`]))
});

export const THEMES = Object.freeze({
  loom: Object.freeze({
    id: 'loom',
    label: 'Loom',
    description: 'Teal, violet, and soft gray — the default cockpit palette.',
    colors: palette({ cyan: '36', teal: '38;5;80', blue: '38;5;111', purple: '38;5;141', magenta: '38;5;141', yellow: '33', red: '31', green: '32', white: '97', gray: '38;5;245', bg: '48;5;235' })
  }),
  ocean: Object.freeze({
    id: 'ocean',
    label: 'Ocean',
    description: 'Cool blues and cyan for long sessions and dark terminals.',
    colors: palette({ cyan: '38;5;123', teal: '38;5;45', blue: '38;5;117', purple: '38;5;147', magenta: '38;5;141', yellow: '38;5;228', red: '38;5;203', green: '38;5;121', white: '97', gray: '38;5;153', bg: '48;5;23' })
  }),
  ember: Object.freeze({
    id: 'ember',
    label: 'Ember',
    description: 'Warm amber, coral, and red accents for a more energetic cockpit.',
    colors: palette({ cyan: '38;5;223', teal: '38;5;215', blue: '38;5;180', purple: '38;5;175', magenta: '38;5;205', yellow: '38;5;214', red: '38;5;196', green: '38;5;149', white: '97', gray: '38;5;250', bg: '48;5;52' })
  }),
  mono: Object.freeze({
    id: 'mono',
    label: 'Mono',
    description: 'Grayscale output for minimal terminals, logs, and accessibility.',
    colors: palette({ cyan: '38;5;250', teal: '38;5;252', blue: '38;5;248', purple: '38;5;246', magenta: '38;5;252', yellow: '38;5;255', red: '38;5;250', green: '38;5;255', white: '97', gray: '38;5;245', bg: '48;5;238' })
  }),
  'high-contrast': Object.freeze({
    id: 'high-contrast',
    label: 'High contrast',
    description: 'Bright semantic colors with a near-black footer for busy terminals.',
    colors: palette({ cyan: '38;5;51', teal: '38;5;51', blue: '38;5;117', purple: '38;5;201', magenta: '38;5;201', yellow: '38;5;226', red: '38;5;196', green: '38;5;46', white: '97', gray: '38;5;255', bg: '48;5;16' })
  })
});

const aliases = new Map([
  ['default', 'loom'],
  ['classic', 'loom'],
  ['highcontrast', 'high-contrast'],
  ['high_contrast', 'high-contrast']
]);

export function normalizeTheme(value = 'loom') {
  const raw = String(value).trim().toLowerCase();
  return aliases.get(raw) || raw;
}

export function resolveTheme(value = 'loom') {
  const id = normalizeTheme(value);
  const theme = THEMES[id];
  if (!theme) throw new Error(`Unknown theme \`${value}\`. Try \`loom theme list\`.`);
  return theme;
}

export function themeSummaries() {
  return Object.values(THEMES).map(({ id, label, description }) => ({ id, label, description }));
}

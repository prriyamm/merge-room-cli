const palette = (values) => Object.freeze({
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  ...Object.fromEntries(Object.entries(values).map(([name, code]) => [name, `\x1b[${code}m`]))
});

export const THEMES = Object.freeze({
  'merge-room': Object.freeze({
    id: 'merge-room',
    label: 'Merge Room',
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
  }),
  'liquid-glass': Object.freeze({
    id: 'liquid-glass',
    label: 'Liquid Glass',
    description: 'Frosted cyan, mist blue, and pale iris over smoked glass.',
    colors: palette({ cyan: '38;5;159', teal: '38;5;152', blue: '38;5;153', purple: '38;5;183', magenta: '38;5;182', yellow: '38;5;223', red: '38;5;174', green: '38;5;151', white: '38;5;255', gray: '38;5;146', bg: '48;5;238' })
  }),
  graphite: Object.freeze({
    id: 'graphite',
    label: 'Graphite',
    description: 'Steel blue, silver, and ash with restrained contrast.',
    colors: palette({ cyan: '38;5;109', teal: '38;5;109', blue: '38;5;110', purple: '38;5;139', magenta: '38;5;139', yellow: '38;5;180', red: '38;5;167', green: '38;5;108', white: '38;5;252', gray: '38;5;245', bg: '48;5;236' })
  }),
  sage: Object.freeze({
    id: 'sage',
    label: 'Sage',
    description: 'Eucalyptus, moss, and warm stone for quiet focus.',
    colors: palette({ cyan: '38;5;151', teal: '38;5;108', blue: '38;5;110', purple: '38;5;146', magenta: '38;5;145', yellow: '38;5;180', red: '38;5;174', green: '38;5;108', white: '38;5;254', gray: '38;5;248', bg: '48;5;237' })
  }),
  dusk: Object.freeze({
    id: 'dusk',
    label: 'Dusk',
    description: 'Dusty blue, muted mauve, and soft rose after sunset.',
    colors: palette({ cyan: '38;5;110', teal: '38;5;109', blue: '38;5;110', purple: '38;5;146', magenta: '38;5;145', yellow: '38;5;180', red: '38;5;174', green: '38;5;108', white: '38;5;252', gray: '38;5;245', bg: '48;5;236' })
  }),
  champagne: Object.freeze({
    id: 'champagne',
    label: 'Champagne',
    description: 'Parchment, antique gold, and warm gray without glare.',
    colors: palette({ cyan: '38;5;180', teal: '38;5;180', blue: '38;5;146', purple: '38;5;182', magenta: '38;5;181', yellow: '38;5;187', red: '38;5;174', green: '38;5;150', white: '38;5;230', gray: '38;5;246', bg: '48;5;236' })
  })
});

const aliases = new Map([
  ['default', 'merge-room'],
  ['classic', 'merge-room'],
  ['liquid', 'liquid-glass'],
  ['glass', 'liquid-glass'],
  ['liquidglass', 'liquid-glass'],
  ['liquid_glass', 'liquid-glass'],
  ['highcontrast', 'high-contrast'],
  ['high_contrast', 'high-contrast']
]);

export function normalizeTheme(value = 'merge-room') {
  const raw = String(value).trim().toLowerCase();
  return aliases.get(raw) || raw;
}

export function resolveTheme(value = 'merge-room') {
  const id = normalizeTheme(value);
  const theme = THEMES[id];
  if (!theme) throw new Error(`Unknown theme \`${value}\`. Try \`merge-room theme list\`.`);
  return theme;
}

export function themeSummaries() {
  return Object.values(THEMES).map(({ id, label, description }) => ({ id, label, description }));
}

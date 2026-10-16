import { isAbsolute, relative, resolve } from 'node:path';

export const calculatorTestNames = [
  'adds values',
  'checks positive numbers',
  'observes module initialization',
];

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Only nondeterministic formatting observed in the pinned Bun command output. */
export function normalizeBunDiagnostic(text, { projectRoot, tempDirName, testNames = calculatorTestNames }) {
  const root = resolve(projectRoot);
  const temporary = resolve(root, tempDirName);
  const owned = relative(root, temporary);
  if (!owned || owned === '..' || owned.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(owned)) {
    throw new Error('Bun diagnostic normalization requires a temporary directory inside projectRoot');
  }
  const prefix = temporary.split(/[\\/]/).map(escape).join('[\\\\/]');
  // Only stack frames under this run's exact temporary directory may lose the
  // random leaf. Test/source filenames, generated frames and coordinates remain.
  const sandbox = new RegExp(`^(\\s+at\\b.*?${prefix}[\\\\/])sandbox-[A-Za-z0-9]+(?=[\\\\/])`, 'gm');
  const titles = testNames.map(escape).join('|');
  const elapsed = new RegExp(`^(\\((?:pass|fail)\\) (?:${titles}))[ \\t]*\\[[0-9]+(?:\\.[0-9]+)?(?:ms|s)\\]$`, 'gm');
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(sandbox, '$1sandbox-<owned>')
    .replace(elapsed, '$1')
    .replace(/^(Ran \d+ tests? across \d+ files?\.)[ \t]*\[[0-9]+(?:\.[0-9]+)?(?:ms|s)\]$/gm, '$1')
    .replace(/\n{2,}/g, '\n');
}

/** Retain every report field, including diagnostics; sort only mutant completion order. */
export function normalizeBunReport(report, options = {}) {
  const context = { projectRoot: report.projectRoot, tempDirName: report.config.tempDirName, ...options };
  return {
    ...report,
    files: Object.fromEntries(Object.entries(report.files).map(([name, file]) => [name, {
      ...file,
      mutants: file.mutants.map((mutant) => ({
        ...mutant,
        ...(typeof mutant.statusReason === 'string'
          ? { statusReason: normalizeBunDiagnostic(mutant.statusReason, context) }
          : {}),
      })).sort((left, right) => left.id.localeCompare(right.id)),
    }])),
  };
}

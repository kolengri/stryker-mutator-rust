import { isAbsolute, relative, resolve } from 'node:path';
import { EOL } from 'node:os';

export const calculatorTestNames = [
  'adds values',
  'checks positive numbers',
  'observes module initialization',
];

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function temporaryDirectory(projectRoot, tempDirName) {
  const root = resolve(projectRoot);
  const temporary = resolve(root, tempDirName);
  const owned = relative(root, temporary);
  if (!owned || owned === '..' || owned.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(owned)) {
    throw new Error('Bun diagnostic normalization requires a temporary directory inside projectRoot');
  }
  return temporary;
}

/** Undo only separators proven to have been inserted by upstream's chunk join. */
export function reassembleUpstreamBunReport(report, captures, { activeMutantVariable, eol = EOL }) {
  const temporary = temporaryDirectory(report.projectRoot, report.config.tempDirName);
  const byId = new Map();
  for (const capture of captures) {
    const { activeMutantId: id } = capture;
    if (capture.version !== 1 || capture.command !== report.config.commandRunner.command
      || typeof capture.cwd !== 'string' || !isAbsolute(capture.cwd)
      || !/^sandbox-[A-Za-z0-9]+$/.test(relative(temporary, capture.cwd))
      || capture.activeMutantVariable !== activeMutantVariable
      || (id !== null && typeof id !== 'string')
      || !Array.isArray(capture.chunks)
      || capture.chunks.some((chunk) => !['stdout', 'stderr'].includes(chunk.stream) || typeof chunk.text !== 'string')
      || !Number.isInteger(capture.exit?.code) || capture.exit.signal !== null) {
      throw new Error('Invalid or unrelated upstream Bun chunk capture');
    }
    if (byId.has(id)) throw new Error(`Duplicate upstream Bun capture for ${id ?? 'baseline'}`);
    byId.set(id, capture);
  }
  if (byId.get(null)?.exit.code !== 0) throw new Error('Missing successful upstream Bun baseline capture');
  const seen = new Set([null]);
  const corrected = {
    ...report,
    files: Object.fromEntries(Object.entries(report.files).map(([name, file]) => [name, {
      ...file,
      mutants: file.mutants.map((mutant) => {
        const capture = byId.get(mutant.id);
        if (!capture) throw new Error(`Missing upstream Bun capture for mutant ${mutant.id}`);
        if (seen.has(mutant.id)) throw new Error(`Duplicate report mutant ${mutant.id}`);
        seen.add(mutant.id);
        if (mutant.status === 'Survived' && capture.exit.code === 0) return mutant;
        if (mutant.status !== 'Killed' || capture.exit.code === 0) {
          throw new Error(`Unexpected upstream Bun outcome for mutant ${mutant.id}`);
        }
        const chunks = capture.chunks.map((chunk) => chunk.text);
        if (mutant.statusReason !== chunks.join(eol)) {
          throw new Error(`Upstream Bun statusReason does not match captured chunks for mutant ${mutant.id}`);
        }
        return { ...mutant, statusReason: chunks.join('') };
      }),
    }])),
  };
  if (seen.size !== byId.size) throw new Error('Unexpected extra upstream Bun mutant capture');
  return corrected;
}

/** Only nondeterministic formatting observed in the pinned Bun command output. */
export function normalizeBunDiagnostic(text, { projectRoot, tempDirName, testNames = calculatorTestNames }) {
  const temporary = temporaryDirectory(projectRoot, tempDirName);
  const prefix = temporary.split(/[\\/]/).map(escape).join('[\\\\/]');
  const relativePrefix = relative(process.cwd(), temporary).split(/[\\/]/).map(escape).join('[\\\\/]');
  // Only stack frames under this run's exact temporary directory may lose the
  // random leaf. Test/source filenames, generated frames and coordinates remain.
  const sandbox = new RegExp(`^(\\s+at\\b.*?${prefix}[\\\\/])sandbox-[A-Za-z0-9]+(?=[\\\\/])`, 'gm');
  const annotationFile = new RegExp(`(^|,)file=((?:${prefix}|${relativePrefix})[\\\\/])sandbox-[A-Za-z0-9]+(?=[\\\\/])`);
  const titles = testNames.map(escape).join('|');
  const elapsed = new RegExp(`^(\\((?:pass|fail)\\) (?:${titles}))[ \\t]*\\[[0-9]+(?:\\.[0-9]+)?(?:ms|s)\\]$`, 'gm');
  return text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(sandbox, '$1sandbox-<owned>')
    // GitHub annotations retain their envelope and encoded message verbatim.
    // Split only the observed newline escape to reuse the stack-frame boundary.
    .replace(/^::(error|warning|notice) ([^\r\n]*?)::([^\r\n]*)$/gm, (_, severity, properties, message) =>
      `::${severity} ${properties.replace(annotationFile, '$1file=$2sandbox-<owned>')}::${message.split('%0A').map((line) => line.replace(sandbox, '$1sandbox-<owned>')).join('%0A')}`)
    .replace(elapsed, '$1')
    .replace(/^(Ran \d+ tests? across \d+ files?\.)[ \t]*\[[0-9]+(?:\.[0-9]+)?(?:ms|s)\]$/gm, '$1');
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

// Report arrays arrive in asynchronous completion order. IDs and all semantic
// fields remain intact; only the outer mutant order is canonicalized.
export function normalizeReport(report) {
  return Object.fromEntries(Object.entries(report.files).map(([name, file]) => [name, {
    source: file.source,
    mutants: file.mutants.map(({ id, mutatorName, replacement, location, status, statusReason, static: isStatic, testsCompleted, killedBy, coveredBy }) =>
      ({ id, mutatorName, replacement, location, status, statusReason, static: isStatic, testsCompleted, killedBy, coveredBy }))
      .sort((a, b) => Number(a.id) - Number(b.id)),
  }]));
}

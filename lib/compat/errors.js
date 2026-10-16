const MAX_ERROR_DEPTH = 8;
const MAX_ERRORS = 256;

function truncated(message) {
  return { name: 'TruncatedError', message };
}

/** Ordinary errors are lossless; aggregate graphs have explicit resource bounds. */
export function errorDetails(error, seen = new WeakSet(), budget = { remaining: MAX_ERRORS }, depth = 0) {
  if (depth > MAX_ERROR_DEPTH) return truncated('Aggregate error details exceeded the nesting limit.');
  if (budget.remaining-- <= 0) return truncated('Aggregate error details exceeded the total error limit.');
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  if (seen.has(error)) return truncated('Circular aggregate error reference omitted.');
  seen.add(error);
  const result = { name: error.name, message: error.message, ...(typeof error.stack === 'string' ? { stack: error.stack } : {}) };
  if (error instanceof AggregateError) {
    const errors = Object.getOwnPropertyDescriptor(error, 'errors')?.value;
    result.errors = [];
    if (Array.isArray(errors)) {
      for (const nested of errors) {
        if (budget.remaining <= 0) {
          result.errors.push(truncated('Additional aggregate errors omitted after the total error limit.'));
          break;
        }
        result.errors.push(errorDetails(nested, seen, budget, depth + 1));
      }
    } else {
      result.errors.push(truncated('Aggregate error details were not an owned array.'));
    }
  }
  // Repeated references in independent branches retain their details. Only an
  // ancestor cycle is truncated, rather than treating aliases as lost errors.
  seen.delete(error);
  return result;
}

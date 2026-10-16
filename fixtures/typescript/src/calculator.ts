type Numeric = number;

export const startup: boolean = true;
export function add(a: Numeric, b: Numeric): Numeric {
  return a + b;
}
export function positive<T extends number>(value: T): boolean {
  return value > 0;
}
export function unused(value: number): number {
  return value * 2;
}

export function removeOptional(container?: { value?: number }): boolean {
  return delete container?.value;
}

export function nonNullValue(box?: { value: { toString(): string } }): string | undefined {
  return box?.value!.toString();
}

export function total(value: number = 1 + 2, ...rest: number[]): number {
  return value + rest.length;
}

export function recover(state: { value: number; finalized: boolean }): number {
  try {
    return inner(state.value);
  } catch (error: any) {
    return error;
  } finally {
    state.finalized = true;
  }

  function inner(value: number): number {
    if (value < 0) throw value;
    return value + 1;
  }
}

export const startup = true;
export function add(a: number, b: number): number {
  return a + b;
}
export function positive(value: number): boolean {
  return value > 0;
}
export function unused(value: number): number {
  return value * 2;
}

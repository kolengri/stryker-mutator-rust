export const startup: boolean = true;

class Base {
  value: number = 1;
}

export class Calculator extends Base {
  #offset: number = 0;
  static enabled: boolean = true;

  constructor(offset: number) {
    super();
    this.#offset = offset;
  }

  add(a: number, b: number): number {
    return a + b + this.#offset;
  }

  get offset(): number {
    return this.#offset;
  }

  set offset(value: number) {
    this.#offset = value;
  }

  unused(value: number): number {
    return value * 2;
  }
}

export function create(offset: number): Calculator {
  return new Calculator(offset);
}

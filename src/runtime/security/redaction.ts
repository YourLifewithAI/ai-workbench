// Registered secret values never reach events, logs, exports, or API responses (D-33).
const MIN_LENGTH = 8;

export class Redactor {
  private readonly secrets = new Map<string, string>(); // value → name

  register(name: string, value: string): void {
    if (!value || value.length < MIN_LENGTH) return;
    this.secrets.set(value, name);
  }

  names(): string[] {
    return [...new Set(this.secrets.values())];
  }

  redactString(input: string): string {
    let out = input;
    for (const [value, name] of this.secrets) {
      if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
    }
    return out;
  }

  /** Structural walk over strings; other values pass through untouched. */
  redact<T>(value: T): T {
    if (typeof value === 'string') return this.redactString(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redact(v)) as unknown as T;
    if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.redact(v);
      return out as T;
    }
    return value;
  }

  redactJson(value: unknown): string {
    return JSON.stringify(this.redact(value));
  }
}

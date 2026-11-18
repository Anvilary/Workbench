/**
 * Base class for structured domain errors carrying a stable machine-readable code.
 */
export class DomainError<TCode extends string = string> extends Error {
  constructor(
    public readonly code: TCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Thrown when a persisted snapshot uses a schema version newer than or incompatible
 * with the running code, preventing silent fallback or backup downgrade.
 */
export class UnsupportedSchemaVersionError extends DomainError<'unsupported-schema'> {
  constructor(storeName: string, version: unknown) {
    super('unsupported-schema', `Unsupported ${storeName} schema version: ${String(version)}`);
  }
}

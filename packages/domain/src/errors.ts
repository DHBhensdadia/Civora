/**
 * Base class for failures this project raises deliberately.
 *
 * The name is set from the concrete subclass so that a logged error identifies
 * the boundary that produced it without any extra plumbing.
 */
export class CivoraError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Raised when a data store cannot satisfy a request. */
export class DataProviderError extends CivoraError {}

/** Raised when an authentication attempt cannot be satisfied. */
export class AuthProviderError extends CivoraError {}

/** Raised when the reasoning layer cannot produce schema-valid output. */
export class ReasoningProviderError extends CivoraError {}

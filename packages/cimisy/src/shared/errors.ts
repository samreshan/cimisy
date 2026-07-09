export class CimisyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "CimisyError";
  }
}

export class NotFoundError extends CimisyError {
  constructor(message: string) {
    super(message, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends CimisyError {
  constructor(message: string) {
    super(message, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends CimisyError {
  constructor(
    message: string,
    public readonly issues: unknown,
  ) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class ConflictError extends CimisyError {
  constructor(message: string) {
    super(message, "CONFLICT");
    this.name = "ConflictError";
  }
}

export class UnsafePathError extends CimisyError {
  constructor(message: string) {
    super(message, "UNSAFE_PATH");
    this.name = "UnsafePathError";
  }
}

export class RateLimitedError extends CimisyError {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message, "RATE_LIMITED");
    this.name = "RateLimitedError";
  }
}

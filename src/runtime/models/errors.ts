// Normalized model errors raised as <Code>Error classes (spec/model-layer.md §Errors, D-05).
import { DEFAULT_ERROR_ACTION, type Meta, type ModelErrorAction, type ModelErrorCode, type ModelErrorShape } from '../../shared/model.js';

export interface ModelErrorOptions { providerError?: Meta | undefined; action?: ModelErrorAction | undefined; retryable?: boolean | undefined }

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly action: ModelErrorAction;
  readonly providerError: Meta | undefined;
  constructor(code: ModelErrorCode, message: string, opts: ModelErrorOptions = {}) {
    super(message);
    this.name = `${code}Error`;
    this.code = code;
    this.action = opts.action ?? DEFAULT_ERROR_ACTION[code];
    this.retryable = opts.retryable ?? this.action === 'retry';
    this.providerError = opts.providerError;
  }
  toShape(): ModelErrorShape {
    return { code: this.code, message: this.message, retryable: this.retryable, action: this.action, ...(this.providerError ? { providerError: this.providerError } : {}) };
  }
}

export class AuthenticationError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('Authentication', m, o); } }
export class RateLimitError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('RateLimit', m, o); } }
export class ContextLengthError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('ContextLength', m, o); } }
export class ModelUnavailableError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('ModelUnavailable', m, o); } }
export class ContentFilterError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('ContentFilter', m, o); } }
export class NetworkError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('Network', m, o); } }
export class TimeoutError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('Timeout', m, o); } }
export class NetworkPolicyError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('NetworkPolicy', m, o); } }
export class SchemaValidationError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('SchemaValidation', m, o); } }
export class UnknownModelError extends ModelError { constructor(m: string, o?: ModelErrorOptions) { super('Unknown', m, o); } }

const CLASSES: Record<ModelErrorCode, new (m: string, o?: ModelErrorOptions) => ModelError> = {
  Authentication: AuthenticationError, RateLimit: RateLimitError, ContextLength: ContextLengthError,
  ModelUnavailable: ModelUnavailableError, ContentFilter: ContentFilterError, Network: NetworkError,
  Timeout: TimeoutError, NetworkPolicy: NetworkPolicyError, SchemaValidation: SchemaValidationError, Unknown: UnknownModelError,
};

export function modelError(code: ModelErrorCode, message: string, opts?: ModelErrorOptions): ModelError {
  return new CLASSES[code](message, opts);
}

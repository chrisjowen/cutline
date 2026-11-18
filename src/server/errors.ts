/** An error that maps directly onto an HTTP response: `{error: {code, message, ...details}}`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const invalidPortalResponse = () =>
  new ApiError(502, "PORTAL_INVALID_RESPONSE", "Unsupported Urja response.");

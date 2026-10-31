// SPDX-License-Identifier: MIT
export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, {status, code, extra});
  }
}
export function ensure(condition, status, code, message, extra) {
  if (!condition) throw new AppError(status, code, message, extra);
}

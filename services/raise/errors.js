/**
 * Driver-raise error construction.
 *
 * Pure: no Telegram requests, no DB. `serviceError` is the single place a raise
 * error gets its stable machine-readable `code` and the HTTP `status` the public
 * and admin raise routes answer with (see server/routes/raiseRoutes.js →
 * sendServiceError), so that contract is defined in one file.
 */

/** Build a raise service error carrying a stable `code` + HTTP `status`. */
function serviceError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

module.exports = { serviceError };

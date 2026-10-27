/**
 * When Save may be pressed on Settings → Facebook ↔ Bitrix. Pure.
 *
 * Only after a Test PASSED with exactly the values now in the form: any edit
 * after the Test — dataset, token or test event code — locks Save again until
 * the next Test. (The server re-proves the token on Save regardless; this is
 * what keeps a person from saving values they never saw tested.)
 */

/** The form's values as one comparable string. */
export function formFingerprint(form) {
  return JSON.stringify([
    String(form?.datasetId ?? '').trim(),
    String(form?.token ?? '').trim(),
    String(form?.testEventCode ?? '').trim(),
  ]);
}

/** `tested` is { fingerprint, passed } from the last Test, or null. */
export function canSave(tested, form) {
  return Boolean(tested && tested.passed && tested.fingerprint === formFingerprint(form));
}

'use strict';

/*
 * Machine-readable error codes for SCOUTBOOK.
 * BOOK translates and retries from `code`, not from the Chinese `error` string.
 *   AUTH_EXPIRED  session/token expired — silent re-login once
 *   NOT_FOUND     troop / member / item missing
 *   RATE_LIMITED  too many attempts
 *   VALIDATION    bad input — do not retry
 * Wrong-password and permission failures must NOT become AUTH_EXPIRED, or a
 * book would re-login with the same bad password and lock the account.
 *
 * Numeric `code` values (401/403/…) are the ecportal leaf contract and stay
 * available as `legacyCode` when a string code replaces them on the proxy.
 */

const MACHINE_CODES = new Set(['AUTH_EXPIRED', 'NOT_FOUND', 'RATE_LIMITED', 'VALIDATION']);

function classifyPartnerError(result, httpStatus) {
  if (!result || result.success !== false) return '';
  if (typeof result.code === 'string' && MACHINE_CODES.has(result.code)) return result.code;
  if (typeof result.errorCode === 'string' && MACHINE_CODES.has(result.errorCode)) return result.errorCode;

  const error = String(result.error || '');
  const numeric = typeof result.code === 'number' ? result.code : Number(httpStatus) || 0;

  // Token/session only. "登入失敗" and "重設碼已過期" must not match.
  if (/Token 無效或過期/.test(error) || /登入狀態無效或已過期/.test(error)) return 'AUTH_EXPIRED';

  if (numeric === 429 || /嘗試次數過多|登入失敗次數過多|請 1 分鐘後再試/.test(error)) return 'RATE_LIMITED';

  if (
    /找不到指定旅團/.test(error) ||
    /找不到此帳號/.test(error) ||
    /找不到用戶/.test(error) ||
    /找不到申請/.test(error) ||
    /找不到紀錄/.test(error) ||
    /成員不存在/.test(error) ||
    /項目不存在/.test(error) ||
    /Sheet not found/i.test(error)
  ) return 'NOT_FOUND';

  if (
    numeric === 400 && (
      /請求資料不完整/.test(error) ||
      /不支援的請求動作/.test(error) ||
      /缺少項目編號/.test(error) ||
      /缺少申報日期/.test(error) ||
      /申請資料不完整/.test(error) ||
      /格式不正確/.test(error)
    )
  ) return 'VALIDATION';

  return '';
}

// Adds `code` / `errorCode` without dropping a numeric leaf code.
// Success payloads (including `{ success:true, duplicate:true }`) pass through.
function annotatePartnerCode(result, httpStatus) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result.success !== false) return result;
  if (typeof result.code === 'string' && MACHINE_CODES.has(result.code)) {
    return result.errorCode ? result : { ...result, errorCode: result.code };
  }
  const machine = classifyPartnerError(result, httpStatus);
  if (!machine) return result;
  const out = { ...result, errorCode: machine };
  if (typeof result.code === 'number') {
    out.legacyCode = result.code;
    out.code = machine;
  } else if (result.code == null || result.code === '') {
    out.code = machine;
  }
  return out;
}

module.exports = {
  MACHINE_CODES,
  classifyPartnerError,
  annotatePartnerCode
};

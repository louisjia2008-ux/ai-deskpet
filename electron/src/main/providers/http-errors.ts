const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Classify a bounded, untrusted error without returning provider text or parameter values. */
export const safeProviderHttpErrorCode = (status:number,body:unknown):string => {
  const error=object(body)&&object(body.error)?body.error:object(body)?body:{};
  const code=typeof error.code==='string'?error.code:'',type=typeof error.type==='string'?error.type:'';
  if (['unsupported_country_region_territory','unsupported_country','region_not_supported'].includes(code)) return 'provider.regionRestricted';
  if (['model_not_found','model_not_available','model_access_denied','invalid_model'].includes(code)) return 'provider.modelUnavailable';
  if (['unsupported_parameter','unsupported_value'].includes(code)) return 'provider.unsupportedParameter';
  // Some Responses rejections have a null code. Classify a known parameter
  // without persisting the untrusted server message or any parameter value.
  if (status === 400 && type === 'invalid_request_error' && ['temperature', 'top_p', 'top_logprobs', 'reasoning.effort'].includes(String(error.param))
    && typeof error.message === 'string' && /not supported|unsupported/iu.test(error.message)) return 'provider.unsupportedParameter';
  if (['insufficient_quota','credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded'].includes(code) || type==='insufficient_quota') return 'provider.quota';
  if (status===401 || code==='invalid_api_key') return 'provider.authentication';
  if (status===403) return 'provider.permissionDenied';
  if (status===402) return 'provider.quota';
  if (status===408 || status===504) return 'provider.timeout';
  if (status===429 || code==='rate_limit_exceeded') return 'provider.rateLimit';
  if (status>=500) return 'provider.unavailable';
  return 'provider.request';
};

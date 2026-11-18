/** These fixed summaries may leave the desktop for a paired QQ recipient.
 * Never interpolate an upstream error, provider name, endpoint or credential. */
const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  'tool.webBudgetExceeded': '本次任务的联网次数已用完，未再发起联网请求。可以缩小剩余问题，或在桌面设置中查看 QQ 联网次数上限。',
  'provider.network': '连接模型服务失败，请检查桌面电脑的网络或代理连接后再试。',
  'provider.timeout': '等待模型服务响应超时，请稍后再试；如果持续超时，请检查桌面电脑的网络或代理连接。',
  'provider.authentication': '模型服务的身份验证未通过，请在桌面设置中检查 API 密钥和访问权限。',
  'provider.credentialsRequired': '模型服务还没有配置密钥，请先在桌面设置中完成配置。',
  'provider.credentialEndpointChanged': '模型服务地址已变更，请在桌面设置中重新确认对应的密钥。',
  'provider.quota': '模型服务的余额或额度不足，请检查服务账户后再试。',
  'provider.rateLimit': '模型服务暂时限制了请求频率，请稍后再试。',
  'provider.limitUnknown': '模型服务限制了这次请求，暂时无法确认具体原因，请在桌面查看服务设置。',
  'provider.unavailable': '模型服务暂时不可用，请稍后再试。',
  'provider.modelUnavailable': '当前模型不可用，请在桌面设置中检查模型选择和访问权限。',
  'provider.regionRestricted': '模型服务限制了当前地区的访问，请在桌面检查服务的可用范围。',
  'provider.request': '模型服务没有接受这次请求，请在桌面检查模型和服务设置。',
  'provider.unsupportedParameter': '当前模型不支持这次请求的设置，请在桌面检查模型配置。',
  'provider.streamInterrupted': '模型服务的回复中断了，这一轮没有完成，请重试。',
  'provider.truncated': '模型回复达到长度限制，这一轮没有完整结束，可以缩小问题范围后再试。',
  'provider.contextBudgetExceeded': '这次请求的内容超出了模型上下文范围，请缩短内容或在新会话中继续。',
  'provider.budgetExceeded': '这次请求超出了设置的用量预算，请在桌面查看预算设置。',
  'provider.cancelled': '这一轮已取消。',
};

export const qqRunFailureText = (code: string, group = false): string => {
  if (code === 'qq.disclosureBlocked') return group ? '这条回复不能发到群里。' : '这条回复不能通过 QQ 发送。';
  return Object.hasOwn(FAILURE_MESSAGES, code) ? FAILURE_MESSAGES[code]! : '这一轮没有完成，请在桌面查看错误详情后重试。';
};

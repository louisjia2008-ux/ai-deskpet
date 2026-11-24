import { z } from 'zod';

/** Wire allowlist: a worker can report these fixed codes, never display text. */
export const wechatSendDiagnostics = {
  send_window_missing: ['No active WeChat window could be found.', '找不到处于前台的微信窗口。'],
  send_window_identity: ['The active window could not be verified as WeChat.', '无法确认前台窗口是微信。'],
  send_window_geometry: ['The WeChat window was hidden or its size or position changed.', '微信窗口不可见，或位置和尺寸已变化。'],
  send_capture_failed: ['The WeChat window could not be captured.', '无法读取微信窗口截图。'],
  send_window_changed: ['WeChat lost focus or its window changed during a check.', '核对时微信失去焦点或窗口发生变化。'],
  send_window_busy: ['Another operation was using the WeChat window.', '微信窗口正在处理其他操作。'],
  send_listener_paused: ['The WeChat listener was paused before the send.', '发送前微信监听已暂停。'],
  send_ocr_failed: ['WeChat window text could not be recognized reliably.', '无法可靠识别微信窗口文字。'],
  send_target_unbound: ['No verified chat is bound to this send.', '这次发送没有可核验的已绑定会话。'],
  send_target_ambiguous: ['The bound chat could not be identified uniquely.', '找不到唯一匹配的已绑定会话。'],
  title_mismatch: ['The open chat title does not match the bound chat.', '当前会话标题与已绑定会话不符。'],
  drawer_state_unknown: ['The chat details panel state could not be verified.', '无法确认聊天详情面板的状态。'],
  drawer_not_open: ['The chat details panel did not open as expected.', '聊天详情面板未按预期打开。'],
  drawer_not_closed: ['The chat details panel could not be verified as closed.', '无法确认聊天详情面板已关闭。'],
  send_owner_profile_unverified: ['The owner profile card could not be verified.', '无法核对主人资料卡。'],
  send_owner_binding_mismatch: ['The owner profile does not match the verified binding.', '主人资料与已验证的私聊绑定不符。'],
  send_group_binding_mismatch: ['The open group does not match its verified binding.', '当前群聊与已验证的绑定不符。'],
  send_draft_occupied: ['The WeChat composer already contains a draft.', '微信输入框已有草稿。'],
  send_draft_mismatch: ['The staged draft could not be verified.', '无法核对待发送草稿。'],
  send_quote_menu_missing: ['The native quote action could not be located.', '找不到可核验的微信引用菜单项。'],
  send_quote_mismatch: ['The quoted message could not be verified.', '无法核对被引用的消息。'],
  send_anchor_mismatch: ['The expected chat bubble could not be verified.', '无法核对用来定位的聊天气泡。'],
  send_input_bounds: ['The GUI action fell outside the verified window.', '界面操作超出了已核验窗口的范围。'],
  send_policy_changed: ['The binding, pause state or send permission changed.', '会话绑定、暂停状态或发送授权发生变化。'],
  send_attempt_unrecorded: ['The send attempt could not be recorded before acting.', '无法在操作前记录发送尝试。'],
  send_receipt_baseline: ['The database could not establish a baseline before the send.', '发送前无法取得数据库回执基线。'],
  send_receipt_unconfirmed: ['The message may have been sent. Delivery is unconfirmed and the message will not be sent again.', '消息可能已发出，目前未确认送达。不会重复发送。'],
  send_receipt_unstored: ['The delivery receipt could not be saved. Check WeChat before trying again.', '未能保存发送回执，请先在微信核对。'],
  send_duplicate: ['An existing matching message prevented another send.', '检测到相同消息，暂未再次发送。'],
  send_check_failed: ['A preflight safety check prevented the WeChat action.', '微信发送前的安全核对没有通过。'],
} as const;

export type WeChatSendReason = keyof typeof wechatSendDiagnostics;
export const wechatSendReasonSchema = z.enum(Object.keys(wechatSendDiagnostics) as WeChatSendReason[]);

export function describeWeChatSendDiagnostics(locale: 'en' | 'zh-CN'): Record<string, string> {
  const label = locale === 'en' ? 0 : 1;
  return Object.fromEntries(Object.entries(wechatSendDiagnostics).map(([code, text]) => [`wechat.${code}`, text[label]]));
}

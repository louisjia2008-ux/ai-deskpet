export const WECHAT_MOMENT_STAGES = [
  'open_window', 'camera', 'select_file', 'attach_images', 'placeholder', 'paste',
  'text_verify', 'visibility', 'post_button', 'window_changed', 'ledger', 'confirm',
] as const;
export type WeChatMomentStage = typeof WECHAT_MOMENT_STAGES[number];

export const WECHAT_MOMENT_STAGE_LABELS: Record<WeChatMomentStage, string> = {
  open_window: '打开朋友圈窗口', camera: '打开相机菜单', select_file: '打开图片选择器',
  attach_images: '选图并添加到草稿', placeholder: '核对文案输入框', paste: '填文字',
  text_verify: '核对文案', visibility: '设置可见范围', post_button: '定位并点击发表按钮',
  window_changed: '核对发表前的窗口', ledger: '检查发布账本', confirm: '核对发布回执',
};

export const isWeChatMomentStage = (value: unknown): value is WeChatMomentStage =>
  typeof value === 'string' && Object.hasOwn(WECHAT_MOMENT_STAGE_LABELS, value);

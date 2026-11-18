import { DOCTOR_CODES, safeDoctorCode, type DoctorRunbookEntry } from '../../shared/doctor';

const general: DoctorRunbookEntry = { causes: ['功能暂时不可用', '运行状态或授权发生变化'], actions: ['在桌宠的运行状态查看对应功能是否启用。'] };
const wechat: DoctorRunbookEntry = { causes: ['微信掉线或虚拟机不可用', '会话绑定或窗口状态变化'], actions: ['打开微信虚拟机窗口，确认微信已登录且没有提示框。', '在渠道设置核对微信绑定状态。'] };
const receipt: DoctorRunbookEntry = { causes: ['发送后数据库尚未同步', '数据库读取或回执保存不可用'], actions: ['在微信窗口核对是否发出，不要重复发送未确认的消息。'] };
const provider: DoctorRunbookEntry = { causes: ['API key 失效或额度不足', '模型服务暂时不可用'], actions: ['在 设置 → 模型 检查 API key、额度和所选模型。'] };
const disk: DoctorRunbookEntry = { causes: ['磁盘空间不足', '日志持续增长'], actions: ['在系统存储页面查看剩余空间。', '请维护人员核对日志增长原因，先不要自行处理文件。'] };
const vmDisk: DoctorRunbookEntry = { causes: ['虚拟机磁盘空间不足', '系统日志持续增长'], actions: ['打开微信虚拟机窗口查看存储状态。', '请维护人员核对虚拟机日志增长原因，先不要自行处理文件。'] };

const fixed: Record<string, DoctorRunbookEntry> = {
  'wechat.selfTestFailed': { causes: ['发送界面或目标核验失败', '数据库发送基线不可读'], actions: ['打开微信虚拟机窗口确认微信已登录。', '查看医生页失败阶段，确认后可手动再测一次。'] },
  'wechat.selfTestUncertain': receipt,
  'wechat.selfTestSkipped': { causes: ['回复队列卡住或监听暂停'], actions: ['在运行状态查看微信队列是否有未确认的消息'] },
  'wechat.vmUnreachable': { causes: ['微信虚拟机未运行或连接不可用', '客体只读体检接口不可用'], actions: ['打开微信虚拟机窗口，查看是否仍在运行和登录。'] },
  'wechat.vmDiskLow': vmDisk, 'wechat.vmDiskCritical': vmDisk, 'wechat.vmLogGrowth': vmDisk,
  'system.diskLow': disk, 'system.diskCritical': disk,
  'provider.authentication': { causes: ['API key 无效或已过期', '模型账号认证被撤销'], actions: ['在 设置 → 模型 检查 API key 和账号认证状态。'] },
  'provider.quota': { causes: ['额度已用完', '模型服务的消费上限被触发'], actions: ['在模型服务的账号页面查看额度与消费上限。'] },
  'knowledge.embeddingModelMissing': { causes: ['选用的嵌入模型尚未准备好'], actions: ['在知识库设置核对嵌入模型是否已准备好。'] },
  'knowledge.indexRepeatedFailures': { causes: ['知识库读取或索引连续失败', '本机嵌入服务不可用'], actions: ['在知识库运行状态查看上次错误类型。'] },
  'app.uncleanExit': { causes: ['上次桌宠异常退出', '系统关闭或进程被强制结束'], actions: ['观察是否再次异常退出；反复出现时请维护人员检查。'] },
};

/** Every known error has a fixed entry, including when no model can run. */
export const DOCTOR_RUNBOOK: Readonly<Record<string, DoctorRunbookEntry>> = Object.fromEntries(Object.keys(DOCTOR_CODES).map(code => {
  const fallback = code.startsWith('provider.') || ['sleep.incomplete', 'sleep.noProvider', 'autoMemory.incomplete'].includes(code) ? provider
    : code.startsWith('wechat.') ? /(?:uncertain|Uncertain|receipt)/u.test(code) ? receipt : wechat
      : code.startsWith('qq.') ? { causes: ['QQ 连接或投递不可用'], actions: ['在渠道设置查看 QQ 连接和授权状态。'] }
        : code.startsWith('telegram.') ? { causes: ['Telegram 连接或投递不可用'], actions: ['在渠道设置查看 Telegram 连接和授权状态。'] }
          : code.startsWith('asr.') ? { causes: ['离线语音组件或麦克风权限不可用'], actions: ['在语音设置查看离线组件及麦克风授权。'] }
            : code.startsWith('diary.') ? { causes: ['日记存储或调度不可用'], actions: ['在日记页面查看运行状态，原文件保持不动。'] } : general;
  return [code, fixed[code] ?? fallback];
}));
export const doctorRunbook = (code: string): DoctorRunbookEntry => DOCTOR_RUNBOOK[safeDoctorCode(code)]!;

export const DOCTOR_GROUP_RULES = [
  { code: 'wechat.vmUnavailable', title: '微信虚拟机可能整体不可用', all: ['wechat.stale', 'wechat.vmUnreachable'],
    include: ['wechat.stale', 'wechat.vmUnreachable', 'wechat.selfTestFailed', 'wechat.selfTestUncertain'] },
  { code: 'wechat.vmStopped', title: '微信虚拟机可能整体不可用', all: ['wechat.stopped', 'wechat.vmUnreachable'],
    include: ['wechat.stopped', 'wechat.vmUnreachable', 'wechat.selfTestFailed', 'wechat.selfTestUncertain'] },
  { code: 'wechat.vmStorage', title: '微信虚拟机磁盘与日志空间异常', all: ['wechat.vmDiskCritical', 'wechat.vmLogGrowth'],
    include: ['wechat.vmDiskCritical', 'wechat.vmDiskLow', 'wechat.vmLogGrowth'] },
] as const;

export const groupDoctorProblems = <T extends { code: string }>(entries: readonly T[]): Array<{ title: string | null; entries: T[] }> => {
  const remaining = new Set(entries), result: Array<{ title: string | null; entries: T[] }> = [];
  for (const rule of DOCTOR_GROUP_RULES) {
    if (!rule.all.every(code => [...remaining].some(entry => entry.code === code))) continue;
    const grouped = [...remaining].filter(entry => (rule.include as readonly string[]).includes(entry.code));
    grouped.forEach(entry => remaining.delete(entry));
    result.push({ title: rule.title, entries: grouped });
  }
  for (const entry of remaining) result.push({ title: null, entries: [entry] });
  return result;
};

export const doctorStaticAdvice = (entries: readonly { code: string }[]): string => {
  const first = entries.find(entry => entry.code === 'wechat.vmDiskCritical' || entry.code === 'system.diskCritical')
    ?? entries.find(entry => entry.code.startsWith('provider.')) ?? entries[0];
  return first ? `建议：${doctorRunbook(first.code).actions[0]}` : '建议：当前采样没有发现异常，若仍无法使用，可在运行状态查看对应功能。';
};

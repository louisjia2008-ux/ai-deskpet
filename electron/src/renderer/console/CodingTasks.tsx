import { useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import type { DeskPetApi, ResolvedLocale } from '../../shared';
import type { CodingTask } from '../../shared/coding-tasks';
import { codingTaskStartSchema } from '../../shared/coding-tasks';
import './background-jobs.css';
import './coding-tasks.css';

type Api = NonNullable<DeskPetApi['coding']>;

const labels = {
  en: {
    title: 'Codex coding tasks',
    help: 'Choose a trusted, clean Git repository. Codex works in a separate copy. Starting a task authorizes the selected code and task instruction to be used by the signed-in Codex account.',
    select: 'Choose repository', instruction: 'What should Codex do?', verification: 'Test command', example: 'Example: node --test',
    start: 'Start Codex task', pause: 'Interrupt task', resume: 'Resume task', empty: 'No coding tasks yet.',
    loadError: 'Could not read saved coding tasks.', actionError: 'The action could not be completed.',
    tests: 'Test result', exit: 'Exit code', diff: 'Git diff', output: 'Execution log', truncated: 'Output reached its display limit.',
    noSession: 'Waiting for a Codex session', session: 'Codex session', noTests: 'Tests have not completed.',
    noDiff: 'No diff is available.', noOutput: 'Waiting for output.',
    statuses: { preparing: 'Preparing workspace', running: 'Running', interrupted: 'Interrupted', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' },
  },
  'zh-CN': {
    title: 'Codex 代码任务',
    help: '选择一个可信、干净的 Git 仓库。Codex 会在独立副本里工作。启动任务即授权当前登录的 Codex 账户处理选定的代码和任务指令。',
    select: '选择仓库', instruction: '交给 Codex 的任务', verification: '测试命令', example: '例如 node --test',
    start: '启动 Codex 任务', pause: '中断任务', resume: '继续任务', empty: '暂无代码任务。',
    loadError: '无法读取已保存的代码任务。', actionError: '操作未完成。',
    tests: '测试结果', exit: '退出码', diff: 'Git 差异', output: '执行记录', truncated: '输出已达到显示上限。',
    noSession: '等待 Codex 会话', session: 'Codex 会话', noTests: '测试尚未完成。',
    noDiff: '暂无差异。', noOutput: '等待输出。',
    statuses: { preparing: '准备工作区', running: '执行中', interrupted: '已中断', completed: '已完成', failed: '失败', cancelled: '已取消' },
  },
} as const;

const active = (task: CodingTask): boolean => task.status === 'preparing' || task.status === 'running';

export const CodingTasks = ({ api, locale }: { api: Api; locale: ResolvedLocale }): JSX.Element => {
  const text = labels[locale];
  const [selection, setSelection] = useState<Awaited<ReturnType<Api['pickRepository']>>>(null);
  const [instruction, setInstruction] = useState('');
  const [verificationCommand, setVerificationCommand] = useState('');
  const [tasks, setTasks] = useState<CodingTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let mounted = true;
    let timer: number;
    const refresh = async (): Promise<void> => {
      try {
        const saved = await api.list();
        if (mounted) { setTasks(saved); setLoadError(false); }
      } catch {
        if (mounted) setLoadError(true);
      } finally {
        if (mounted) timer = window.setTimeout(() => void refresh(), 1200);
      }
    };
    void refresh();
    return () => { mounted = false; window.clearTimeout(timer); };
  }, [api]);

  const act = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (cause) {
      const reason = cause instanceof Error ? cause.message : '';
      const readable = reason.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
      setError(readable || text.actionError);
    }
    finally { setBusy(false); }
  };

  const start = (event: FormEvent): void => {
    event.preventDefault();
    if (!selection || busy) return;
    void act(async () => {
      await api.start({ selectionId: selection.selectionId, instruction, verificationCommand });
      setSelection(null);
      setInstruction('');
      setVerificationCommand('');
    });
  };

  return <section className="background-jobs coding-tasks">
    <section className="panel">
      <h1>{text.title}</h1>
      <p className="background-job-note">{text.help}</p>
      <form className="background-job-form" onSubmit={start}>
        <div className="button-row coding-repository">
          <button type="button" className="secondary" disabled={busy} onClick={() => void act(async () => {
            const picked = await api.pickRepository();
            if (picked) setSelection(picked);
          })}>{text.select}</button>
          {selection && <span>{selection.path}</span>}
        </div>
        <label>{text.instruction}<textarea value={instruction} maxLength={codingTaskStartSchema.shape.instruction.maxLength ?? undefined} required onChange={event => setInstruction(event.target.value)} /></label>
        <label>{text.verification}<input value={verificationCommand} maxLength={codingTaskStartSchema.shape.verificationCommand.maxLength ?? undefined} placeholder={text.example} required onChange={event => setVerificationCommand(event.target.value)} /></label>
        <div><button type="submit" className="primary" disabled={busy || tasks.some(active) || !selection || !instruction.trim() || !verificationCommand.trim()}>{text.start}</button></div>
      </form>
      {error && <p role="alert">{error}</p>}
      {loadError && <p role="alert">{text.loadError}</p>}
    </section>
    <div className="background-job-list">
      {!tasks.length && !loadError && <p>{text.empty}</p>}
      {tasks.map(task => <article key={task.id} className="panel coding-task" data-testid="coding-task">
        <h2>{task.instruction}</h2>
        <p><strong role="status">{text.statuses[task.status]}</strong></p>
        <p className="background-job-note">{task.repository}</p>
        <p className="background-job-note">{task.sessionId ? <>{text.session} <code data-testid="coding-session">{task.sessionId}</code></> : text.noSession}</p>
        {task.error && <p role="alert">{task.error}</p>}
        {task.summary && <p>{task.summary}</p>}
        <div className="background-job-actions">
          {active(task) && <button className="secondary" type="button" disabled={busy} onClick={() => void act(async () => { await api.interrupt(task.id); })}>{text.pause}</button>}
          {(task.status === 'interrupted' || task.status === 'failed') && task.sessionId && <button className="primary" type="button" disabled={busy || tasks.some(active)} onClick={() => void act(async () => { await api.resume(task.id); })}>{text.resume}</button>}
        </div>
        <details>
          <summary>{text.tests}</summary>
          {task.verification ? <>
            <p><code>{task.verificationCommand}</code> · {text.exit} {task.verification.exitCode ?? '—'}</p>
            {task.verification.truncated && <p>{text.truncated}</p>}
            <pre data-testid="coding-test-output">{task.verification.output}</pre>
          </> : <p>{text.noTests}</p>}
        </details>
        <details>
          <summary>{text.diff}</summary>
          {task.diffTruncated && <p>{text.truncated}</p>}
          <pre data-testid="coding-diff">{task.diff || text.noDiff}</pre>
        </details>
        <details>
          <summary>{text.output}</summary>
          <pre>{task.output || text.noOutput}</pre>
        </details>
      </article>)}
    </div>
  </section>;
};

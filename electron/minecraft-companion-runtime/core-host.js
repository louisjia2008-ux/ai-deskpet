'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateConfig, MAX_LINE_BYTES } = require('./protocol');
const { withMinecraftProtocolCompatibility, installMinecraftBedWakeCompatibility } = require('./protocolCompatibility');
const { acknowledgePlayerLoaded, flattenReason } = require('./runtime');
const { GOAL_SCHEMAS, TOOLS, validateTool } = require('./core-tools');
const { perceive } = require('./core/perception');
const { installSurveyPlanReceiver } = require('./core/survey-plan-receiver');

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const problem = (code, message, retryable = false) => Object.assign(new Error(message), { code, retryable });
const errorData = (error) => ({ code: error.code || 'invalid_request', message: String(error.message || error).slice(0, 2000), retryable: error.retryable === true });
const clone = (value) => JSON.parse(JSON.stringify(value));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// The house the bot built, kept across connections. A LAN world gets a new
// port every time it is opened: the world is told by its server host and
// world spawn instead. Reconnected, the bot had forgotten its house: it dug
// in at night beside its own bed, and "build a house" built a second one.
function createHomeStore(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
  return (key) => key && ({
    load: () => read()[key] ?? null,
    save(value) {
      const all = read();
      all[key] = value;
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(all), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    },
  });
}

function worldKey(host, bot) {
  const s = bot.spawnPoint;
  // Never sent (the default 0,0,0): no way to tell one world from another.
  if (!s || (s.x === 0 && s.y === 0 && s.z === 0)) return null;
  return `${String(host).toLowerCase()}|${s.x},${s.y},${s.z}`;
}

/** A single-bot, data-only tool host. Dispatch promises are NOT task completion. */
function createCoreHost({ dataDir, emit = () => {}, createBot = require('mineflayer').createBot,
  createCompanion = require('./core/companion').createCompanion, now = Date.now,
  surveyPlanDryRun = false, surveyPlanMode = surveyPlanDryRun ? 'dry_run' : 'off',
  observeSurveyPlans = false, managedWorldAutonomy = false,
  historyLimit = 256, historyTtlMs = 10 * 60 * 1000, connectTimeoutMs = 60000, maxPending = 64 } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new TypeError('An absolute dataDir is required');
  if (!['off', 'dry_run', 'execute'].includes(surveyPlanMode)) throw new TypeError('Invalid survey plan mode');
  if (!Number.isInteger(historyLimit) || historyLimit < 2 || !Number.isFinite(historyTtlMs) || historyTtlMs < 1
      || !Number.isInteger(maxPending) || maxPending < 1 || !Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 1) {
    throw new TypeError('Invalid host limits');
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const homes = createHomeStore(path.join(dataDir, 'homes.json'));
  let bot = null;
  let companion = null;
  let disposeSurveyPlan = null;
  let config = null;
  let generation = 0;
  let active = null;
  let survey = null;
  let surveyStatus = null;
  let closed = false;
  let closePromise = null;
  let connection = { state: 'disconnected', generation, automaticReconnect: false };
  let timer = null;
  let queue = Promise.resolve();
  let pending = 0;
  let cleanup = Promise.resolve();
  const tasks = new Map();
  const requests = new Map();
  const surveyInventories = new Map();
  const isLocalOffline = (candidate) => candidate?.host === '127.0.0.1' && candidate?.auth === 'offline';
  // Observer failures must not leave a task half-transitioned.
  const send = (message) => { try { emit(clone(message)); } catch { /* transport owns delivery */ } };
  const event = (payload) => send({ version: 1, type: 'event', event: { at: now(), ...payload } });
  function setConnection(state, error) {
    connection = { state, generation, automaticReconnect: false, ...(error ? { error } : {}) };
    event({ type: 'connection', ...connection });
  }
  function prune() {
    for (const [id, task] of tasks) {
      if (TERMINAL.has(task.status) && now() - task.updatedAt >= historyTtlMs) tasks.delete(id);
    }
    for (const [id, request] of requests) {
      const task = tasks.get(request.taskId);
      if (request.done && (!task || TERMINAL.has(task.status)) && now() - request.at >= historyTtlMs) requests.delete(id);
    }
    while (tasks.size > historyLimit) {
      const oldest = [...tasks].find(([, task]) => TERMINAL.has(task.status));
      if (!oldest) break;
      tasks.delete(oldest[0]);
    }
  }
  function updateTask(task, status, details = {}) {
    if (!task || TERMINAL.has(task.status)) return;
    Object.assign(task, details, { status, updatedAt: now() });
    if (TERMINAL.has(status)) {
      task.paused = false;
      if (active === task) active = null;
    }
    event({ type: 'task', taskId: task.taskId, task });
    prune();
  }
  function coreEvent(payload, epoch) {
    if (closed || epoch !== generation) return;
    if (payload.type === 'goal_cleanup_error') {
      event({ type: 'core', taskId: payload.taskId || null, connectionGeneration: epoch, payload });
      void detach({ code: 'goal_cleanup_failed', message: 'Goal resource cleanup failed; connection closed', retryable: false },
        { failed: true }).catch(() => {});
      return;
    }
    // Never infer correlation from the current goal's name.
    const task = payload.taskId ? tasks.get(payload.taskId) : null;
    if (task && task === survey?.task && ['goal_done', 'goal_failed'].includes(payload.type)) {
      // A local failure can ask the Mod to pause. Only the paired Mod
      // revocation may publish a completed construction task.
      try { survey.grant.blocked('survey_execution_error', undefined, (payload.reasons || ['local_goal_ended']).join(', ').slice(0, 240)); } catch { /* receiver owns the connection */ }
      return;
    }
    if (task && task.connectionGeneration === epoch && !TERMINAL.has(task.status)) {
      if (payload.type === 'goal_set') updateTask(task, 'running');
      else if (payload.type === 'goal_done') updateTask(task, 'completed', { progress: payload.progress });
      else if (payload.type === 'goal_failed') updateTask(task, 'failed', {
        error: { code: 'goal_failed', message: (payload.reasons || []).join('; ').slice(0, 2000), retryable: false },
      });
      // goal_cleared only revokes the goal definition. Its body may still be
      // retiring, so the controlling operation publishes cancelled after join.
    }
    event({ type: 'core', taskId: payload.taskId || null, connectionGeneration: epoch, payload });
  }
  function detach(reason, { failed = false, dispose = false } = {}) {
    const previousEpoch = generation;
    generation += 1; // invalidate old transport and core callbacks BEFORE cleanup
    clearTimeout(timer); timer = null;
    const oldBot = bot; const oldCompanion = companion;
    const detachedTask = active;
    const interruptedSurvey = detachedTask && detachedTask === survey?.task;
    bot = null; companion = null;
    disposeSurveyPlan?.();
    disposeSurveyPlan = null;
    survey = null;
    surveyStatus = null;
    if (detachedTask && (failed || interruptedSurvey)) updateTask(detachedTask, 'failed', { error: reason });
    if (interruptedSurvey) {
      const { taskId, name, planId, revision } = detachedTask;
      event({ type: 'core', taskId, connectionGeneration: previousEpoch, payload: {
        type: 'goal_failed', goal: name, taskId, planId, revision, reasons: [reason.message], code: reason.code,
      } });
    }
    setConnection(dispose ? 'disposed' : failed ? 'error' : 'disconnected', failed ? reason : undefined);
    // Queue cleanup so reconnect cannot attach a new engine before the old one
    // has released its body/listeners. Tasks are never automatically replayed.
    cleanup = cleanup.then(async () => {
      try {
        await oldCompanion?.dispose();
        if (detachedTask && !failed) updateTask(detachedTask, 'cancelled', { reason: reason.message });
      } finally {
        try { oldBot?.clearControlStates?.(); } catch { /* disconnected */ }
        try { oldBot?.quit?.(reason.code); } catch { /* disconnected */ }
        try { oldBot?._client?.end?.(reason.code); } catch { /* disconnected */ }
        try { oldBot?._client?.socket?.destroy?.(); } catch { /* disconnected */ }
      }
    }).catch((error) => {
      // A teardown which did not complete cannot safely admit a new engine.
      // Remain fail-closed, but do not advertise a reconnect we cannot perform.
      const failure = error.code === 'cleanup_failed' ? error
        : problem('cleanup_failed', 'Companion cleanup failed; restart the host before reconnecting');
      if (detachedTask) updateTask(detachedTask, 'failed', { error: errorData(error) });
      setConnection(closed ? 'disposed' : 'error', errorData(failure));
      throw Object.assign(failure, detachedTask ? { task: detachedTask } : {});
    });
    // Keep the rejection observable to the caller without an unhandled event.
    cleanup.catch((error) => event({ type: 'cleanup_error', error: errorData(error) }));
    return cleanup;
  }
  async function connect(nextConfig) {
    await cleanup;
    if (closed) throw problem('disposed', 'Host is permanently closed');
    config = nextConfig;
    const epoch = ++generation;
    setConnection('connecting');
    if (closed || epoch !== generation) throw problem('disposed', 'Connection was cancelled before creation');
    let next;
    try {
      next = createBot(withMinecraftProtocolCompatibility({
        host: config.host, port: config.port, username: config.username, auth: config.auth, version: config.version,
        profilesFolder: path.join(dataDir, 'microsoft-profiles'), hideErrors: true,
        onMsaCode: (code) => {
          if (epoch !== generation || closed) return;
          event({ type: 'auth_device_code', userCode: String(code.user_code || code.userCode || ''),
            verificationURI: String(code.verification_uri || code.verificationUri || ''), expiresIn: Number(code.expires_in || 0) });
        },
      }));
    } catch (error) {
      const detail = { ...errorData(error), code: 'connect_failed', retryable: true };
      setConnection('error', detail);
      throw problem(detail.code, detail.message, detail.retryable);
    }
    bot = next;
    const current = () => !closed && epoch === generation && bot === next;
    const managed = managedWorldAutonomy && isLocalOffline(nextConfig);
    const observe = observeSurveyPlans && isLocalOffline(nextConfig);
    let deathReported = false;
    const review = (reason, detail) => event({ type: 'managed_world_review', connectionGeneration: epoch, reason, detail });
    const lost = (code, message) => {
      if (!current()) return;
      void detach({ code, message, retryable: true }, { failed: true }).catch(() => {});
    };
    if (surveyPlanMode !== 'off' || observe) {
      let reservation = null;
      disposeSurveyPlan = installSurveyPlanReceiver(next, {
        mode: surveyPlanMode,
        observe,
        ledgerDir: path.join(dataDir, 'survey-plan-grants'),
        onEvent(payload) {
          if (!current()) return;
          if (payload.type === 'status') {
            const { worldId, initial, current: selected, plan } = payload;
            if (selected !== false) surveyStatus = clone({ worldId, plan });
            event({ type: 'survey_plan_status', connectionGeneration: epoch, worldId, initial, current: selected, plan });
            return;
          }
          event({ type: surveyPlanMode === 'dry_run' ? 'survey_plan_dry_run' : 'survey_plan', payload });
          if (payload.type === 'stop_failed') lost('survey_stop_failed', payload.reason);
        },
        async onPrepare(plan, grant) {
          if (!current() || connection.state !== 'ready' || !companion || survey) throw problem('not_ready', 'The body is unavailable for a survey authorization');
          const previous = active;
          reservation = { grant, engine: companion, task: null, inventoryKey: `${plan.worldId}:${plan.planId}` };
          survey = reservation;
          await reservation.engine.prepareSurveyPlan(plan, grant);
          if (previous) updateTask(previous, 'cancelled', { reason: 'survey_plan' });
        },
        async onRun(plan, grant, identity) {
          if (!current() || !reservation || reservation !== survey || reservation.grant !== grant || grant.signal.aborted) return;
          const task = { taskId: randomUUID(), name: 'survey_plan', status: 'accepted', paused: false,
            createdAt: now(), updatedAt: now(), connectionGeneration: epoch, planId: identity.planId, revision: identity.revision };
          reservation.task = task;
          tasks.set(task.taskId, task); active = task;
          event({ type: 'task', taskId: task.taskId, task });
          const { createSurveyPlanGoal } = require('./core/goals/surveyPlan');
          const { createSurveyInventory } = require('./core/survey-supplies');
          const supplyInventory = surveyInventories.get(reservation.inventoryKey) ?? createSurveyInventory(next);
          surveyInventories.set(reservation.inventoryKey, supplyInventory);
          const goal = createSurveyPlanGoal({ bot: next, plan, grant, supplyInventory });
          await reservation.engine.startSurveyPlan(grant, goal, { taskId: task.taskId });
        },
        async onStop(grant, { status, reason }) {
          const record = reservation;
          if (!record || record.grant !== grant) return;
          if (['completed', 'failed', 'cancelled', 'expired'].includes(status)) surveyInventories.delete(record.inventoryKey);
          await record.engine.stopSurveyPlan(grant, reason || status);
          reservation = null;
          if (!current() || survey !== record) return;
          survey = null;
          if (managed) await record.engine.setAutonomy(true);
          if (!record.task) return;
          const task = record.task;
          const done = status === 'completed';
          const payload = { type: done ? 'goal_done' : 'goal_failed', goal: task.name, taskId: task.taskId,
            planId: task.planId, revision: task.revision, modStatus: status, ...(done ? { progress: 1 } : { reasons: [reason || status] }) };
          coreEvent(payload, epoch);
        },
      });
    }
    // These closures stay on their original bot and never affect a later one.
    next.on('error', (error) => lost('connection_error', String(error.message || error)));
    next.on('kicked', (reason) => lost('kicked', flattenReason(reason) || 'Server kicked the bot'));
    next.on('end', (reason) => lost('disconnected', String(reason || 'Connection ended')));
    if (managed) {
      next.on('death', () => {
        if (!current() || deathReported || connection.state !== 'ready') return;
        deathReported = true;
        const pos = next.entity?.position;
        const where = pos && [pos.x, pos.y, pos.z].every(Number.isFinite)
          ? ` ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}` : '';
        review('death', `机器人死亡${where}`);
      });
    }
    // Player chat is data for the parent to judge; the host never acts on it.
    next.on('chat', (username, message) => {
      if (!current() || connection.state !== 'ready' || username === next.username) return;
      event({ type: 'player_chat', connectionGeneration: epoch, username: String(username).slice(0, 64), message: String(message).slice(0, 256) });
    });
    let spawnEpoch = 0;
    next.on('spawn', async () => {
      if (!current()) return;
      deathReported = false;
      const spawn = ++spawnEpoch;
      const valid = () => current() && spawn === spawnEpoch;
      try {
        await next.waitForChunksToLoad?.();
        await acknowledgePlayerLoaded(next, valid);
        if (!valid()) return;
        installMinecraftBedWakeCompatibility(next);
        if (!companion) companion = createCompanion({
          bot: next,
          autonomy: managed,
          ownerName: nextConfig.ownerName || null,
          onEvent(payload) {
            if (!current()) return;
            if (managed && payload.type === 'autonomy_cooldown') {
              const reasons = Array.isArray(payload.reasons) ? payload.reasons.map(String) : [];
              if (!reasons.some((reason) => reason === 'death' || reason.startsWith('death_loop:'))) {
                review('task_failure', [payload.card, ...reasons].join(' · ').slice(0, 600));
              }
            }
            coreEvent(payload, epoch);
          },
          home: homes(worldKey(nextConfig.host, next)) || null,
        });
        clearTimeout(timer); timer = null;
        setConnection('ready');
      } catch (error) {
        if (valid()) lost('initialization_failed', String(error.message || error));
      }
    });
    timer = setTimeout(() => lost('connect_timeout', 'World readiness timed out; reconnect explicitly'), connectTimeoutMs);
    timer.unref?.();
    return { connection: clone(connection) };
  }
  function observation() {
    if (connection.state !== 'ready' || !bot) return null;
    try {
      const state = perceive(bot, { now });
      if (!state.position) return null;
      return clone({ at: state.at, alive: state.alive, health: state.health, food: state.food,
        position: state.position, dimension: bot.game?.dimension ?? null,
        inventory: state.inventory, freeSlots: state.freeSlots, isDay: state.isDay, timeOfDay: state.timeOfDay,
        home: companion?.home?.() ?? null });
    } catch { return null; } // World transitions can temporarily invalidate a client snapshot.
  }
  function status() {
    prune();
    const engine = companion ? companion.status() : null;
    return { connection: clone(connection), task: active ? clone(active) : null,
      engine,
      observation: observation(),
      ...(surveyStatus ? { surveyPlan: clone(surveyStatus) } : {}),
      policy: companion?.policy?.() ?? null,
      safetyActive: connection.state === 'ready' && Boolean(companion) && !engine?.blocked && !engine?.disposed,
      recovery: 'explicit_reconnect_then_new_request',
      idempotency: { limit: historyLimit, ttlMs: historyTtlMs, persistent: false } };
  }
  function currentTask(id) {
    const task = tasks.get(id);
    if (!task) throw problem('task_not_found', 'Task is unknown or its bounded history expired');
    if (TERMINAL.has(task.status)) return task;
    if (task !== active) throw problem('task_not_active', 'Task is not the active task');
    return task;
  }
  async function tool(message, request) {
    const { name, arguments: args = {} } = message;
    validateTool(name, args);
    if (name === 'listTools') return { tools: TOOLS };
    if (name === 'getStatus') return status();
    if (name === 'getTask') return { task: clone(currentTask(args.taskId)) };
    if (name === 'setPolicy') {
      if (connection.state !== 'ready' || !companion) throw problem('not_ready', 'Connect and wait for connection.ready before setting a policy', true);
      return { policy: companion.setPolicy(args) };
    }
    if (name === 'stopAll') {
      await detach({ code: 'stopped_all', message: 'Host stopped all activity and disconnected' });
      return status();
    }
    if (Object.hasOwn(GOAL_SCHEMAS, name)) {
      if (connection.state !== 'ready' || !companion) throw problem('not_ready', 'Connect and wait for connection.ready before submitting a task', true);
      if (survey) throw problem('survey_owns_body', 'The Minecraft owner controls the active survey from the wand menu', true);
      if (active && !message.replaceCurrent) throw problem('busy', 'A task already owns the body; cancel it or explicitly replaceCurrent', true);
      if (active) {
        const previous = active;
        try { await companion.cancelTask('replaced', { keepAutonomy: managedWorldAutonomy && isLocalOffline(config) }); } catch (error) {
          updateTask(previous, 'failed', { error: errorData(error) });
          throw Object.assign(error, { task: previous });
        }
        updateTask(previous, 'cancelled', { reason: 'replaced' });
      }
      // Cancellation may await I/O. A kick or external close during that wait
      // must not admit work into the disconnected/replaced generation.
      if (closed || connection.state !== 'ready' || !companion) throw problem('not_ready', 'Connection ended during task replacement', true);
      if (survey) throw problem('survey_owns_body', 'The Minecraft owner controls the active survey from the wand menu', true);
      const task = { taskId: randomUUID(), requestId: message.id, name, status: 'accepted', paused: false,
        createdAt: now(), updatedAt: now(), connectionGeneration: generation };
      request.taskId = task.taskId;
      tasks.set(task.taskId, task); active = task;
      event({ type: 'task', taskId: task.taskId, task });
      try {
        await companion.submitTask(name, args, { taskId: task.taskId });
      } catch (error) {
        updateTask(task, 'failed', { error: errorData(error) });
        throw Object.assign(error, { task });
      }
      return { task: clone(task), dispatchOnly: true };
    }
    const task = currentTask(args.taskId);
    if (TERMINAL.has(task.status)) return { task: clone(task) };
    if (!companion) throw problem('not_ready', 'No live companion is attached', true);
    if (survey) throw problem('survey_owns_body', 'The Minecraft owner controls the active survey from the wand menu', true);
    try {
      if (name === 'cancel') {
        await companion.cancelTask('host_cancel', { keepAutonomy: managedWorldAutonomy && isLocalOffline(config) });
        updateTask(task, 'cancelled', { reason: 'host_cancel' });
      } else if (name === 'pause') {
        await companion.pauseTask('host_pause');
        updateTask(task, task.status, { paused: true });
      } else if (name === 'resume') {
        await companion.resumeTask();
        updateTask(task, task.status, { paused: false });
      }
    } catch (error) {
      updateTask(task, 'failed', { error: errorData(error) });
      throw Object.assign(error, { task });
    }
    return { task: clone(task) };
  }
  async function execute(message, request) {
    if (closed) throw problem('disposed', 'Host is permanently closed');
    if (message.type === 'tool') return tool(message, request);
    if (message.type === 'connect' || message.type === 'reconnect') {
      const nextConfig = message.config === undefined && message.type === 'reconnect' && config ? config : validateConfig(message.config);
      if (bot && message.type === 'connect') throw problem('already_connected', 'Use reconnect explicitly to replace a connection');
      if (message.type === 'reconnect') await detach({ code: 'reconnect', message: 'Host explicitly reconnected' });
      return connect(nextConfig);
    }
    if (message.type === 'disconnect') {
      await detach({ code: 'host_disconnect', message: 'Host disconnected' });
      return status();
    }
    if (message.type === 'say') {
      if (connection.state !== 'ready' || !bot) throw problem('not_ready', 'Connect and wait for connection.ready before chatting', true);
      bot.chat(message.text);
      return { said: true };
    }
    if (message.type === 'shutdown') { await close(); return status(); }
    throw problem('unsupported_type', 'Use connect, reconnect, disconnect, tool, say or shutdown with the core engine');
  }
  function validateMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.version !== 1) throw problem('invalid_request', 'Expected a version 1 object');
    if (typeof message.id !== 'string' || !message.id.trim() || message.id.length > 128) throw problem('invalid_request', 'id must be 1..128 characters');
    if (!['connect', 'reconnect', 'disconnect', 'tool', 'say', 'shutdown'].includes(message.type)) throw problem('unsupported_type', 'Unsupported core message type');
    const fields = ['version', 'id', 'type', ...(message.type === 'tool' ? ['name', 'arguments', 'replaceCurrent'] : message.type === 'say' ? ['text'] : ['config'])];
    if (Object.keys(message).some((key) => !fields.includes(key))) throw problem('invalid_request', 'Unexpected envelope field');
    if (message.replaceCurrent !== undefined && typeof message.replaceCurrent !== 'boolean') throw problem('invalid_request', 'replaceCurrent must be boolean');
    if (message.type === 'tool') validateTool(message.name, message.arguments);
    // Plain chat only: a leading slash would run a server command as the bot.
    if (message.type === 'say' && (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 256
        || /[\r\n]/.test(message.text) || message.text.trimStart().startsWith('/'))) throw problem('invalid_request', 'say text must be one plain line of 1..256 characters');
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_LINE_BYTES) throw problem('invalid_request', 'Request exceeds size limit');
  }
  async function handle(input) {
    let message;
    const id = typeof input?.id === 'string' ? input.id.slice(0, 128) : undefined;
    const reply = (result) => { const response = clone({ version: 1, type: 'reply', id, ...result }); send(response); return response; };
    try {
      // Normalize direct calls to the same data-only semantics as JSONL input.
      message = clone(input);
      validateMessage(message);
      prune();
      const fingerprint = canonical(message);
      const previous = requests.get(message.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw problem('id_conflict', 'This request id was already used for different content');
        return reply(await previous.promise);
      }
      if (pending >= maxPending) throw problem('overloaded', 'Too many pending requests', true);
      while (requests.size >= historyLimit) {
        const oldest = [...requests].find(([, record]) => record.done && (!active || record.taskId !== active.taskId));
        if (!oldest) throw problem('overloaded', 'Idempotency history is occupied by pending requests', true);
        requests.delete(oldest[0]);
      }
      const record = { fingerprint, at: now(), done: false };
      pending += 1;
      record.promise = queue.then(() => execute(message, record))
        .then((result) => ({ ok: true, result }), (error) => ({ ok: false, error: errorData(error), ...(error.task ? { task: clone(error.task) } : {}) }))
        .then((result) => { record.done = true; record.at = now(); pending -= 1; return result; });
      requests.set(message.id, record);
      queue = record.promise.then(() => {});
      return reply(await record.promise);
    } catch (error) { return reply({ ok: false, error: errorData(error) }); }
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    surveyInventories.clear();
    closePromise = detach({ code: 'disposed', message: 'Host disposed' }, { dispose: true });
    return closePromise;
  }
  send({ version: 1, type: 'ready', engine: 'core', capabilities: {
    tools: TOOLS, taskLifecycle: true, pauseKeepsSafety: true, automaticReconnect: false,
    surveyPlanMode,
    idempotency: { limit: historyLimit, ttlMs: historyTtlMs, persistent: false },
  } });
  return { handle, close, status };
}

module.exports = { createCoreHost };

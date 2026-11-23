'use strict';
// Wires the brain to a live Mineflayer bot: perception, survival behaviors,
// conservative movement settings and the decision tick.

const { dimension } = require('./nether');
const { Vec3 } = require('vec3');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { createBrain } = require('./brain');
const { schedulingInputs } = require('./scheduling');
const { perceive, ownedItems, countInventory } = require('./perception');
const { createDoctor, recordDoctorInput, D1 } = require('./doctor');
const { createSurvivalBehaviors, enabledDuringSurvey } = require('./behaviors/survival');
const { createRecovery } = require('./behaviors/recovery');
const { createNightRest, isDaylight, nightShelter } = require('./behaviors/nightRest');
const { createEndHazards } = require('./behaviors/endHazards');
const { createHomeMaintenance } = require('./behaviors/homeMaintenance');
const { createGatherLogsGoal } = require('./goals/gatherBlocks');
const { createHomesteadGoal } = require('./goals/homestead');
const { homeContains } = require('./home-topology');
const { createFarmGoal } = require('./goals/farm');
const { createRanchGoal } = require('./goals/ranch');
const { installDigTimeFix } = require('./digTime');
const { installCheapDigging } = require('./mining');
const { installPlacedMemory } = require('./placed');
const { createGatherMaterialsGoal } = require('./goals/gatherMaterials');
const { createCobbleGeneratorGoal } = require('./goals/cobbleGenerator');
const { createAutoSmelterGoal } = require('./goals/autoSmelter');
const { createCaneFarmGoal } = require('./goals/caneFarm');
const { createMobFarmGoal } = require('./goals/mobFarm');
const { createIronFarmGoal } = require('./goals/ironFarm');
const { createVillageIronFarmGoal } = require('./goals/villageIronFarm');
const { createCarpetDuperGoal } = require('./goals/carpetDuper');
const { createFishingGoal } = require('./goals/fishing');
const { createRailDuperGoal } = require('./goals/railDuper');
const { createNetherQuartzGoal } = require('./goals/netherQuartz');
const { createNetherExpeditionGoal } = require('./goals/netherExpedition');
const { createEndDragonGoal } = require('./goals/endDragon');
const { createEnterEndGoal } = require('./goals/enterEnd');
const { createEndCityGoal } = require('./goals/endCity');
const { createEndJourneyGoal } = require('./goals/endJourney');
const { createDefaultCards, homeOf } = require('./goals/registry');
const { createOutfitGoal } = require('./goals/outfit');
const { createHuntPearlsGoal } = require('./goals/huntPearls');
const { createFollowOwnerGoal } = require('./goals/followOwner');
const { createDirector } = require('./director');
const { haltBody } = require('./actions');
const { installInventoryCompatibility } = require('./inventory');
const { installEdgeNudge } = require('./edgeNudge');
const { installEntityGeometry } = require('./entityGeometry');
const { trackReturnPositions } = require('./pathReturn');
const { installOpenDoorPassage, uninstallOpenDoorPassage } = require('./openDoorPassage');
const { installSurveyActions } = require('./survey-plan-actions');
const { applyWalkOnlyMovements } = require('./nether');

// Goals that bring food themselves: hunger leaves the body to them. Following
// the owner keeps hunting close by too: chasing food 145 blocks off left the
// owner it had just been asked to guard to the zombies.
const FEEDING_GOALS = new Set(['farm', 'harvest_wheat', 'stock_food', 'follow_owner']);

// Never build scaffolding, pillar up or parkour on the surface: the bot must not leave
// self-placed obstacles behind, and a target that needs such moves is skipped.
const SPRINT_FOOD = 18;
function configureMovements(bot) {
  const movements = new Movements(bot);
  movements.canDig = true;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  movements.allowParkour = false;
  // Sprinting costs a food point every 40 blocks; walking costs nothing. A
  // bot sprinting everywhere spent a third of its hours hunting for food.
  // It sprints only on a full stomach (whoever else turns sprinting off, the
  // nether and the End, still does).
  let sprint = true;
  Object.defineProperty(movements, 'allowSprinting', {
    configurable: true, enumerable: true,
    get: () => sprint && !(Number.isFinite(bot.food) && bot.food < SPRINT_FOOD),
    set: (value) => { sprint = Boolean(value); },
  });
  // What was set, hunger aside: saved and restored around the nether and the End.
  Object.defineProperty(movements, 'sprintSetting', { configurable: true, get: () => sprint });
  movements.maxDropDown = 4; // a 4-block drop costs one heart; 3 strands the bot on tree tops
  movements.infiniteLiquidDropdownDistance = false;
  movements.canOpenDoors = true;
  // Fences and gates are someone's pen; the furniture and machine parts are
  // home (chasing a skeleton out of the house once broke the bed, and the bot
  // slept outside after that). Paths walk around or through, never dig them.
  const KEEP = /(_fence|_fence_gate|_bed|_door|^chest|^trapped_chest|^furnace|^crafting_table|^hopper|^barrel)$/;
  for (const block of Object.values(bot.registry.blocksByName)) {
    if (KEEP.test(block.name)) movements.blocksCantBreak.add(block.id);
    if (block.name.endsWith('_bed')) movements.blocksToAvoid.add(block.id);
  }
  // Water is allowed but costly: banning it left the bot unable to reach
  // anything across a lake (all the animals on the far shore).
  movements.liquidCost = 5;
  // Walking across tree canopies strands the bot on leaves with long drops on
  // every side; stepping onto leaves is allowed but costly.
  const leaves = new Set(Object.values(bot.registry.blocksByName).filter((b) => b.name.endsWith('_leaves')).map((b) => b.id));
  movements.exclusionAreasStep.push((block) => {
    if (!block?.position) return 0;
    const below = bot.blockAt(block.position.offset(0, -1, 0));
    if (block.name?.endsWith('_bed') || below?.name.endsWith('_bed')) return 1000;
    return below && leaves.has(below.type) ? 25 : 0;
  });
  const farmland = bot.registry.blocksByName.farmland;
  if (farmland) movements.blocksCantBreak.add(farmland.id);
  // Native drop moves check the takeoff level, so inspect every landing cell.
  const neighbors = movements.getNeighbors;
  movements.getNeighbors = function (node) {
    return neighbors.call(this, node).filter(move => bot.blockAt(move.offset(0, -1, 0))?.name !== 'farmland');
  };
  trackReturnPositions(bot, movements);
  installOpenDoorPassage(bot, movements);
  const protection = (block) => bot.companionPlayerBlock?.(block?.position) ? 100 : 0;
  movements.exclusionAreasBreak.push(protection);
  movements.exclusionAreasPlace.push(protection);
  bot.pathfinder.setMovements(movements);
  // Mining paths through stone need more search time than surface walks.
  bot.pathfinder.thinkTimeout = 10000;
  return movements;
}

/**
 * `home`: { load(), save(value) } for this world's house across connections
 * (core-host keeps one per world), or null to remember it only while connected.
 */
function createCompanion({ bot, onEvent: publish = () => {}, tickMs = 250, autonomy = false, retirementTimeoutMs = 20000, ownerName = null,
  home = null, adaptationStore = null, autonomyRange = 'overworld' } = {}) {
  if (!bot) throw new TypeError('bot is required');
  if (!Number.isFinite(retirementTimeoutMs) || retirementTimeoutMs <= 0 || retirementTimeoutMs > 2147483647) {
    throw new TypeError('retirementTimeoutMs must be a positive timer duration');
  }
  const doctor = createDoctor();
  let doctorSequence = 0;
  function onEvent(event) {
    const input = recordDoctorInput(event, ++doctorSequence, bot.entity?.position);
    if (!Number.isFinite(input.at)) input.doctorAt = Date.now();
    publish(input);
    // Diagnostics never feed back into the brain or director, even if an
    // observation or its transport fails.
    try {
      for (const alert of doctor.accept(input)) publish(alert);
    } catch { /* diagnostic observer */ }
  }
  const priorHomeProtection = bot.companionProtectBlock;
  installInventoryCompatibility(bot);
  installDigTimeFix(bot);
  const removeEdgeNudge = installEdgeNudge(bot);
  if (!bot.pathfinder) bot.loadPlugin(pathfinder);
  installCheapDigging(bot);
  const removePlacedMemory = installPlacedMemory(bot);
  const removeEntityGeometry = installEntityGeometry(bot);
  const configuredMovements = configureMovements(bot);

  // Stuck bodies, full bags and death loops are recovered for every goal alike.
  const recovery = createRecovery({ bot, stopOnDeathLoop: () => !director?.ownsGoal() });
  // Animals the current goal keeps (a ranch's herd) are not hunted for food.
  let spare = () => false;
  let director = null;
  let brain = null;
  let paused = false;
  let disposed = false;
  let disposal = null;
  let taskEpoch = 0;
  let dispatch = Promise.resolve();
  let dispatching = 0;
  let retirement = Promise.resolve();
  let retiring = 0;
  let retirementFailed = false;
  let survey = null;
  let goalOwner = null;
  const priorHomestead = bot.companionHomestead;
  const priorHomeTarget = bot.companionHomeTarget;
  const priorFailureLedger = bot.companionFailureLedger;
  const homestead = () => goalOwner?.goal?.name === 'homestead' ? goalOwner.goal : director?.memory.homestead;
  bot.companionHomestead = homestead;
  const atHome = (position, world) => String(world || 'overworld').replace(/^minecraft:/, '') === 'overworld'
    && (homeContains(homestead()?.memory?.house, position) || (position && director?.memory.extraChests
      ?.some(p => p.x === Math.floor(position.x) && p.y === Math.floor(position.y) && p.z === Math.floor(position.z))));
  bot.companionHomeTarget = atHome;
  const playerProtected = (position, world) => world === dimension(bot)
    && bot.companionPlayerBlock?.(new Vec3(position.x, position.y, position.z));
  const adaptation = autonomy ? require('./adaptation').createAdaptation({ store: adaptationStore, onEvent, atHome, playerProtected }) : null;
  const failureLedger = adaptation?.failureLedger || require('./failure-ledger').createFailureLedger({
    protectedTarget: (position, world) => atHome(position, world) || playerProtected(position, world),
  });
  bot.companionFailureLedger = failureLedger;
  const selfStuck = require('./self-stuck').createSelfStuck(bot, { emit: (type, data) => onEvent({ type, at: Date.now(), ...data }) });
  const priorSelfStuck = bot.companionSelfStuck;
  bot.companionSelfStuck = selfStuck;
  const policy = { risk: 'normal', guard: 'self_first' };
  // The connection owns this evidence even while a cached goal is retired.
  // Goal-local death listeners cannot witness deaths during other tasks.
  const priorBodyLife = Object.getOwnPropertyDescriptor(bot, 'companionBodyLife');
  const bodyLifeOwner = Object.freeze({});
  let bodyLifeEpoch = 0;
  let surveyDeathEpoch = null;
  const readBodyLife = () => !disposed && bot.companionBodyLife === readBodyLife
    ? { owner: bodyLifeOwner, epoch: bodyLifeEpoch } : null;
  Object.defineProperty(bot, 'companionBodyLife', { value: readBodyLife, writable: true, configurable: true });
  const assertActive = () => {
    if (disposed) throw Object.assign(new Error('Companion is disposed'), { code: 'disposed' });
  };
  const assertBodyAvailable = () => {
    assertActive();
    if (brain?.status().blocked) throw Object.assign(new Error('An aborted behavior still owns the body; wait for it to settle'),
      { code: 'retirement_timeout', retryable: false });
  };
  async function joinRetirement() {
    let timer;
    try {
      await Promise.race([retirement, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Goal retirement has not settled'),
          { code: 'retirement_timeout', retryable: false })), retirementTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  const nightRest = createNightRest({ bot, adaptation,
    activeGoal: () => brain?.status().goal?.name,
    shelterDoor: (ctx, open) => homestead()?.shelterDoor?.(ctx, open),
    enterShelter: (ctx) => homestead()?.enterShelter?.(ctx),
    prepareSeals: () => Boolean(autonomy && director?.isEnabled() && !survey && !paused && (!goalOwner || director.ownsGoal())
      && !homestead()?.memory.established),
    home: () => {
      const site = homestead()?.shelterSite?.();
      return site ? { ...nightShelter(bot, site), inside: site.inside, entrance: site.house.entrance } : { bed: null, centre: null };
    } });
  const homeMaintenance = createHomeMaintenance({ bot, home: () => director?.memory.homestead,
    activeGoal: () => brain?.status().goal?.name,
    mayRepair: () => !paused && director?.isEnabled() && (!goalOwner || director.ownsGoal()) });
  const homeEscape = require('./behaviors/homeEscape').createHomeEscape({ bot, tracker: selfStuck, home: homestead, adaptation });
  const behaviors = [...createSurvivalBehaviors({ bot, spare: (entity) => spare(entity), autonomousHunt: autonomy,
    feeding: () => FEEDING_GOALS.has(brain?.status().goal?.name),
    // The departure gate is 18; the ordinary survival threshold is 14.
    // Otherwise a healthy bot with food in hand can wait forever at 15–17.
    thresholds: autonomy ? { eatFood: 17, provisionInjured: 18 } : {},
    activeGoal: () => brain?.status().goal?.name,
    surveyArea: () => survey?.area ?? null,
    suppressDeathDrops: () => surveyDeathEpoch === bodyLifeEpoch,
    home: () => (director ? homeOf(director.memory)?.centre || null : null) }), ...recovery.behaviors,
    homeEscape, nightRest, homeMaintenance, ...createEndHazards({ bot, onEvent: (event) => onEvent(event) }),
    ...(adaptation ? [require('./behaviors/mineRetreat').createMineRetreat({ bot, adaptation,
      enabled: () => !survey && director?.ownsGoal() })] : [])];
  const usedGoals = new Set();
  function retireGoal(owner) {
    if (!owner || owner.retiring) return retirement;
    owner.retiring = true;
    if (goalOwner === owner) goalOwner = null;
    // Capture only the old invocation, never a later task's promise. Goal
    // terminal events are emitted before the running body has fully settled.
    const settled = brain.idleGoal(owner.generation);
    retiring += 1;
    retirement = retirement.then(() => settled).then(async () => {
      await owner.goal.dispose?.();
      usedGoals.delete(owner.goal);
    }).catch((error) => {
      retirementFailed = true;
      void director?.disable('goal_cleanup_failed').catch(() => {});
      const failure = Object.assign(new Error(String(error?.message || error), { cause: error }),
        { code: 'cleanup_failed', retryable: false });
      try { onEvent({ type: 'goal_cleanup_error', at: Date.now(), goal: owner.goal.name,
        taskId: owner.taskId, generation: owner.generation, reason: failure.message,
        code: failure.code, retryable: false }); } catch { /* observer */ }
      throw failure;
    }).finally(() => { retiring -= 1; });
    // The failed cleanup is joined by cancellation/new dispatch/disposal, but
    // natural completion can begin it without any waiting caller.
    retirement.catch(() => {});
    return retirement;
  }
  let homeSaved = null;
  const releaseHomeJobs = () => {
    for (const key of ['wheatFarm', 'wheatHarvest', 'wheatFarmDone', 'wheatPlots', 'cobbleGenerator', 'autoSmelter',
      'extraChests', 'autonomyStock']) delete director.memory[key];
    director.memory.homePending = true;
    homeSaved = null;
  };
  function rememberHome() {
    const memory = director?.memory.homestead?.memory;
    if (!home || (!memory?.house && !memory?.relocation?.anchor)) return;
    const structure = memory.house ? { anchor: memory.house.anchor, variant: memory.house.variant, established: memory.established === true,
      pinned: memory.pinned === true, verified: { ...memory.verified },
      construction: { owned: memory.owned, temporary: memory.temporary, breach: memory.breach, materialFallbacks: memory.materialFallbacks,
        furniture: Object.fromEntries(['crafting_table', 'furnace', 'chest', 'bed', 'guestBed']
          .map(id => [id, memory.house.furniture[id]])) } } : { anchor: null };
    const value = { ...structure,
      ...(autonomy ? { progression: Object.fromEntries(progressionFields.filter((key) => director.memory[key] !== undefined)
        .map((key) => [key, director.memory[key]])) } : {}) };
    const text = JSON.stringify(value);
    if (text === homeSaved) return;
    homeSaved = text;
    try { home.save(value); } catch { /* remembered while connected all the same */ }
  }
  const useGoal = (goal, metadata) => {
    assertActive();
    const owner = { goal, taskId: metadata?.taskId ?? goal.metadata?.taskId ?? goal.taskId };
    goalOwner = owner;
    usedGoals.add(goal);
    spare = goal.spares || (() => false);
    try { return brain.setGoal(goal, metadata); } catch (error) { retireGoal(owner); throw error; }
  };
  const schedule = (state, details) => schedulingInputs(state, {
    home: homestead()?.memory.house?.interiorCenter, ...details,
  });
  brain = createBrain({
    schedule,
    taskAllowed: (state, def) => Boolean(survey) || nightRest.taskAllowed(state, def.name),
    abandonMs: retirementTimeoutMs,
    perceive: () => perceive(bot),
    behaviors,
    permanentEnabled: (behavior) => !survey ||
      Boolean(survey.restoreMovements && !survey.grant.signal.aborted && !survey.closing && enabledDuringSurvey(behavior)),
    onEvent: (event) => {
      if (event.type === 'behavior_abandoned') haltBody(bot);
      if (event.type === 'home_access_relocated') releaseHomeJobs();
      if (event.type === 'goal_set' && goalOwner) goalOwner.generation = event.generation;
      // Release invocation-owned listeners/movement hooks, not a historical
      // list of all goals ever submitted to this long-lived companion.
      if (['goal_done', 'goal_failed', 'goal_cleared', 'goal_yielded', 'stopped'].includes(event.type)) {
        spare = () => false;
        if (event.goal === 'homestead' || goalOwner?.goal?.name === 'homestead') {
          (goalOwner?.goal || director?.memory.homestead)?.requestCleanup?.();
        }
        if (goalOwner && event.generation === goalOwner.generation) retireGoal(goalOwner);
      }
      recovery.observe(event);
      director?.handleEvent(event);
      rememberHome();
      onEvent(event);
    },
  });
  recovery.attach(brain);
  // With no player task the director picks the next goal itself; off unless asked for.
  const { cards, reserveCards, stageOf, range, litEnd } = createDefaultCards({ bot, progression: autonomy });
  const progressionFields = ['milestones', 'announced', 'announcementTimes', 'routeDeaths', 'stagePauses', 'extraChests', 'wheatFarmDone', 'wheatPlots', 'cautiousAfterDeath', 'endPortal'];
  function setRisk(risk) {
    bot.companionSetRisk?.(risk);
    policy.risk = risk;
  }
  const announcement = {
    diamond_pickaxe: '做出钻石镐了', nether: '第一次进了下界', blaze_rod: '拿到了烈焰棒',
    end: '找到了要塞并进了末地', dragon: '打败了末影龙',
  };
  function observeProgress() {
    if (!autonomy || !bot.entity) return;
    const memory = director.memory;
    const state = perceive(bot);
    const { inventory, alive } = state;
    if (!alive) return;
    const at = Date.now();
    const homeGoal = memory.homestead;
    if (dimension(bot) === 'overworld') homeGoal?.observeParts?.(state, at, (type, fields) => {
      const { running: behavior, goal } = brain.status();
      onEvent({ type, ...fields, behavior, goal: goal?.name || null, at });
    });
    if (homeGoal && !homeGoal.memory.house && director.isEnabled() && !survey && !paused && (!goalOwner || director.ownsGoal())
      && dimension(bot) === 'overworld') {
      const behavior = brain.status().running;
      if (behavior && behavior !== 'goal:homestead') {
        homeGoal.scoutSite?.(state, adaptation, (type, fields) => onEvent({ type, ...fields, behavior, at }));
      }
    }
    if (bot.companionEndPortal) memory.endPortal = bot.companionEndPortal;
    const facts = {
      diamond_pickaxe: inventory.diamond_pickaxe,
      nether: dimension(bot) === 'the_nether',
      blaze_rod: inventory.blaze_rod,
      end: dimension(bot) === 'the_end',
      dragon: litEnd(),
    };
    memory.milestones ||= {};
    for (const [id, reached] of Object.entries(facts)) {
      if (reached && !memory.milestones[id]) {
        memory.milestones[id] = at;
        onEvent({ type: 'autonomy_milestone', milestone: id, at });
      }
    }
    if (!ownerName || !bot.players?.[ownerName]) return;
    memory.announced ||= [];
    const window = (memory.announcementTimes ||= []).filter((time) => at - time < 60 * 60_000);
    if (window.length >= 3) return;
    const pending = Object.keys(memory.milestones).filter((id) => announcement[id] && !memory.announced.includes(id));
    if (!pending.length) return;
    const away = pending.length > 1 || at - memory.milestones[pending[0]] > 5000;
    bot.chat(`${away ? '你不在的时候我' : '我'}${pending.map((id) => announcement[id]).join('，')}。`);
    memory.announced.push(...pending);
    memory.announcementTimes = [...window, at];
  }
  // Its goals go through useGoal too, so an autonomous ranch also spares its herd.
  const directorBrain = { status: () => brain.status(), setGoal: useGoal, clearGoal: (reason) => brain.clearGoal(reason) };
  director = createDirector({ brain: directorBrain, perceive: () => perceive(bot), cards, reserveCards, stageOf, scope: range, onEvent, adaptation,
    onIdle(state, reason) {
      if (reason === 'no_eligible_card_until_retry' && state.isDay !== false && !state.sheltered) selfStuck.requestProbe();
    },
    onOverworldDeath(death, deaths, memory) {
      if (!memory.cautiousAfterDeath) {
        setRisk('cautious');
        memory.cautiousAfterDeath = true;
        onEvent({ type: 'autonomy_risk_changed', at: death.at, card: death.card, risk: policy.risk, reason: 'overworld_death' });
      }
      const goal = memory.homestead;
      const anchor = goal?.memory.house?.anchor;
      const mine = bot.companionMineRoute;
      const downMine = death.position && mine && death.position.y < mine.surfaceY - 1
        && (Math.hypot(death.position.x - mine.front.x, death.position.z - mine.front.z) < 32
          || require('./mining').knownOpen(mine, death.position));
      if (death.position && (death.card === 'diamond_tools' || downMine)) {
        adaptation?.teach('mine_danger', death.position, 'overworld', 'death_in_mine', 64);
        if (downMine) adaptation?.teach('mine_danger', mine.entrance, 'overworld', 'death_in_mine', 64);
        if (death.card === 'diamond_tools' && anchor) adaptation?.promote('diamond', { position: anchor }, 'different_region', 'death_in_mine');
      }
      if (!anchor || !death.position || goal.memory.established || goal.memory.pinned) return;
      const near = (d) => d.position && Math.hypot(d.position.x - anchor.x, d.position.z - anchor.z) <= 40;
      if (near(death) && deaths.filter((d) => !d.expedition && d.dimension === 'overworld' && death.at - d.at < 60 * 60_000 && near(d)).length >= 2) {
        goal.memory.relocate = true;
      }
    } });
  // The house built on an earlier connection: its plan follows from the corner.
  let savedHome = null;
  try { savedHome = home?.load() ?? null; } catch { /* a home store that cannot be read is no home */ }
  const corner = savedHome?.anchor;
  if (corner && [corner.x, corner.y, corner.z].every(Number.isInteger)
    && (savedHome.established || savedHome.pinned !== false || !adaptation?.avoids('rejected_site', corner))) {
    const variant = ['compact', 'hillside'].includes(savedHome.variant) ? savedHome.variant : 'starter';
    const goal = createHomesteadGoal({ bot, anchor: corner, variant, autonomous: autonomy && savedHome.pinned === false });
    goal.memory.established = savedHome.established === true;
    // A site the bot chose itself may still be given up, as before the reconnect.
    goal.memory.pinned = savedHome.pinned !== false;
    goal.restoreConstruction(savedHome.construction);
    for (const key of Object.keys(goal.memory.verified)) goal.memory.verified[key] = savedHome.verified?.[key] === true;
    director.memory.homestead = goal;
  }
  // Where home is, for a bot lost at sea (actions.swimAshore).
  bot.companionHomeAt = () => homeOf(director.memory)?.centre || null;
  if (autonomy) {
    director.memory.range = autonomyRange;
    for (const key of progressionFields) if (savedHome?.progression?.[key] !== undefined) {
      director.memory[key] = savedHome.progression[key];
    }
    adaptation?.pruneHome();
    if (!director.memory.wheatPlots?.length) director.memory.wheatFarmDone = false;
    director.memory.homePending = Boolean(director.memory.homestead);
    if (director.memory.cautiousAfterDeath) setRisk('cautious');
    if (director.memory.endPortal) bot.companionEndPortal = director.memory.endPortal;
    director.enable();
  }
  let nextDoctorObservation = 0;
  function observeDoctor() {
    const at = Date.now();
    if (at < nextDoctorObservation || !bot.entity?.position) return;
    nextDoctorObservation = at + D1.sampleIntervalMs;
    const memory = homestead()?.memory;
    const house = memory?.house;
    const position = ({ x, y, z }) => ({ x, y, z });
    const owner = bot.companionGuarding ? bot.players?.[bot.companionGuarding]?.entity?.position : null;
    const timeOfDay = bot.time?.timeOfDay ?? null;
    onEvent({ type: 'doctor_observation', at, position: position(bot.entity.position), dimension: bot.game?.dimension ?? null,
      alive: bot.health > 0, inventory: countInventory(ownedItems(bot)),
      isDay: isDaylight(timeOfDay), timeOfDay, home: house ? { anchor: position(house.anchor), size: house.size,
        usable: memory.established === true, finished: memory.established === true && memory.upgradesComplete === true } : null,
      sheltered: bot.companionSheltered === true, sleeping: bot.isSleeping === true, mining: bot.targetDigBlock?.name ?? null,
      ownerPosition: owner ? position(owner) : null, paused, survey: Boolean(survey), inWater: bot.entity.isInWater === true,
    });
  }
  let nextProgressObservation = 0;
  const timer = setInterval(() => {
    if (disposed) return;
    try {
      if (autonomy && Date.now() >= nextProgressObservation) {
        nextProgressObservation = Date.now() + 1000;
        observeProgress();
        rememberHome();
      }
      selfStuck.moved();
      if (!survey && !paused && !dispatching && !retiring && !retirementFailed && !brain.status().blocked
        && !selfStuck.state() && !selfStuck.probe() && !director.memory.homestead?.needsCleanup?.()) director.tick();
    } catch (error) { onEvent({ type: 'autonomy_error', at: Date.now(), reason: String(error?.message || error) }); }
    brain.tick().catch(() => {});
    try { observeDoctor(); } catch { /* diagnostic observer */ }
  }, tickMs);
  timer.unref?.();
  // Death interrupts the current action only: progress lives in the world, so
  // after respawning the goal simply re-plans from what is left. The body stops
  // too: a path goal set by a chase outlives the action, and after a nether death
  // the pathfinder walked on towards its nether coordinates across the overworld.
  // Effects die with the body too, but the server sends no removal for them:
  // a fire resistance kept on the client after a death meant the bot never
  // drank again, and burned to death at the next blaze.
  let routeDeathAt = null;
  const onDeathMessage = (message) => {
    if (routeDeathAt === null || Date.now() - routeDeathAt > 3000 || typeof message !== 'string'
        || !message.startsWith(`${bot.username} `)) return;
    director.noteDeath(message.slice(bot.username.length + 1, 161), { at: routeDeathAt });
  };
  if (autonomy) bot.on('messagestr', onDeathMessage);
  const onDeath = () => {
    if (disposed) return;
    selfStuck.release();
    // Survival's death listener has already checked which life just ended.
    if (autonomy && director.isEnabled()) {
      routeDeathAt = Date.now();
      const cause = recovery.lastDeathCause();
      const position = bot.entity?.position?.floored();
      if (director.noteDeath(cause, { at: routeDeathAt, dimension: dimension(bot), position })) {
        brain.failGoal('death_loop: autonomy stage paused').catch(() => {});
      }
    }
    bodyLifeEpoch += 1;
    surveyDeathEpoch = null;
    bot.companionMineRoute = null;
    if (bot.entity?.effects) bot.entity.effects = {};
    haltBody(bot);
    brain.interrupt('death').catch(() => {});
  };
  const onRespawn = () => { if (!disposed) haltBody(bot); };
  bot.on('death', onDeath);
  bot.on('respawn', onRespawn);

  function startPlayerGoal(create, metadata, returnGoal = true) {
    assertBodyAvailable();
    if (survey) throw Object.assign(new Error('A survey authorization owns the body'), { code: 'survey_owns_body' });
    const epoch = ++taskEpoch;
    dispatching += 1;
    const operation = dispatch.then(async () => {
      assertActive();
      if (epoch !== taskEpoch) throw Object.assign(new Error('Task dispatch was cancelled'), { code: 'aborted' });
      if (goalOwner) await brain.clearGoal('replaced');
      await joinRetirement();
      assertBodyAvailable();
      if (epoch !== taskEpoch) throw Object.assign(new Error('Task dispatch was cancelled'), { code: 'aborted' });
      // Factories themselves can install listeners or movement overrides, so
      // construct only after the previous invocation restored its resources.
      const goal = create();
      director.notePlayerGoal();
      paused = false;
      useGoal(goal, metadata);
      await brain.tick();
      return returnGoal ? goal : undefined;
    }).finally(() => { dispatching -= 1; });
    dispatch = operation.catch(() => {});
    return operation;
  }

  function stopSurveyBody() {
    haltBody(bot);
    try { bot.stopDigging?.(); } catch { /* may already be disconnected */ }
    try { bot.currentWindow?.close?.(); } catch { /* may already be disconnected */ }
  }

  function releaseSurvey(record) {
    if (survey !== record) return;
    record.grant.signal.removeEventListener('abort', stopSurveyBody);
    record.restoreMovements?.();
    record.restoreActions();
    survey = null;
  }

  function prepareSurveyPlan(plan, grant) {
    assertBodyAvailable();
    if (survey || grant.signal.aborted) throw new Error('Survey authorization cannot reserve the body');
    const { minX, maxX, minZ, maxZ } = plan.selection;
    const area = { x: (minX + maxX + 1) / 2, z: (minZ + maxZ + 1) / 2 };
    const record = { grant, area, lifeEpoch: bodyLifeEpoch, restoreActions: installSurveyActions(bot, plan, grant) };
    survey = record;
    grant.signal.addEventListener('abort', stopSurveyBody, { once: true });
    stopSurveyBody();
    taskEpoch += 1;
    paused = false;
    record.prepared = Promise.all([director.disable('survey_plan'), brain.stop('survey_plan'), dispatch]).then(async () => {
      await joinRetirement();
      if (grant.signal.aborted || disposed) return;
      assertBodyAvailable();
      const restoreWalkOnly = applyWalkOnlyMovements(bot, { maxDrop: plan.template?.id === 'wheat_field' ? 1 : 3 });
      const movements = bot.pathfinder.movements;
      const openDoors = movements.canOpenDoors;
      movements.canOpenDoors = false;
      record.restoreMovements = () => {
        movements.canOpenDoors = openDoors;
        restoreWalkOnly();
      };
    });
    return record.prepared;
  }
  const goalMethod = (create) => (options = {}, metadata) => startPlayerGoal(
    () => create({ bot, ...options }), metadata ?? { taskId: options?.taskId });
  const tasks = {
    gatherLogs: (count, metadata) => startPlayerGoal(() => createGatherLogsGoal({ bot, count }), metadata, false),
    homestead(options = {}, metadata) {
      // "Build it here", said by the owner: here is where they stand, not the bot.
      if (options.nearOwner) {
        const entity = ownerName ? bot.players?.[ownerName]?.entity : null;
        if (!entity) {
          return Promise.reject(Object.assign(new Error(ownerName ? 'The owner is not in sight' : 'No owner player name is configured'),
            { code: ownerName ? 'owner_not_in_sight' : 'no_owner' }));
        }
        const { nearOwner, ...rest } = options;
        options = { ...rest, near: entity.position.floored() };
      }
      return startPlayerGoal(() => {
        // One house per run: keep building the house the player asked for.
        const goal = Object.keys(options).length === 0 && director.memory.homestead
          ? director.memory.homestead : createHomesteadGoal({ bot, ...options });
        director.memory.homestead = goal;
        adaptation?.pruneHome();
        // Asked again: the search for a site starts over.
        if (goal.memory) goal.memory.exploreStreak = 0;
        return goal;
      }, metadata ?? { taskId: options?.taskId });
    },
    farm: goalMethod(createFarmGoal),
    ranch: goalMethod(createRanchGoal),
    netherQuartz: goalMethod(createNetherQuartzGoal),
    /** Fortress (blaze rods, wither skulls) and bastion (piglin bartering), then home. */
    netherExpedition: goalMethod(createNetherExpeditionGoal),
    enterEnd: goalMethod(createEnterEndGoal),
    endJourney: goalMethod(createEndJourneyGoal),
    endCity: goalMethod(createEndCityGoal),
    endDragon: goalMethod(createEndDragonGoal),
    // Asked for by the owner: around the chest, not wherever the trees lead.
    gatherMaterials: (options = {}, metadata) => goalMethod(createGatherMaterialsGoal)({ searchRadius: 128, ...options }, metadata),
    cobbleGenerator: goalMethod(createCobbleGeneratorGoal),
    autoSmelter: goalMethod(createAutoSmelterGoal),
    caneFarm: goalMethod(createCaneFarmGoal),
    mobFarm: goalMethod(createMobFarmGoal),
    ironFarm: goalMethod(createIronFarmGoal),
    villageIronFarm: goalMethod(createVillageIronFarmGoal),
    carpetDuper: goalMethod(createCarpetDuperGoal),
    railDuper: goalMethod(createRailDuperGoal),
    fishing: goalMethod(createFishingGoal),
    /** Endermen at night until the bag holds `count` pearls (or the night ends). */
    huntPearls: goalMethod(createHuntPearlsGoal),
    /** Walk to the configured owner; with `stay`, keep following and guarding them until cancelled. */
    followOwner(options = {}, metadata) {
      if (!ownerName) return Promise.reject(Object.assign(new Error('No owner player name is configured'), { code: 'no_owner' }));
      return startPlayerGoal(() => createFollowOwnerGoal({ bot, owner: ownerName, stay: options.stay === true }),
        metadata ?? { taskId: options?.taskId }, false);
    },
    /** Carry `items` ([{ key, count }]), gathered into the house chest first, and wear the armour among them. */
    outfit(options = {}, metadata) {
      const home = homeOf(director.memory);
      if (!home) return Promise.reject(Object.assign(new Error('No finished house yet'), { code: 'no_home' }));
      return startPlayerGoal(() => createOutfitGoal({ bot, ...options, home }), metadata ?? { taskId: options?.taskId });
    },
  };

  function dispose() {
    if (disposal) return disposal;
    if (!disposed) {
      disposed = true;
      taskEpoch += 1;
      paused = false;
      clearInterval(timer);
      bot.removeListener('death', onDeath);
      bot.removeListener('messagestr', onDeathMessage);
      bot.removeListener('respawn', onRespawn);
      removeEdgeNudge();
      removePlacedMemory();
      removeEntityGeometry();
    }
    // Both calls start synchronously: director cannot choose more work, and
    // brain cannot restart a reflex while an abort or goal cleanup is pending.
    const stoppingDirector = director.disable('disposed');
    const stoppingBrain = brain.dispose();
    stoppingDirector.catch(() => {});
    const operation = (async () => {
      // Never dispose invocation-owned resources while its continuation can
      // still use them. A timeout rejects shutdown; a later call may retry.
      const errors = [];
      for (const join of [() => stoppingBrain, () => stoppingDirector, joinRetirement]) {
        try { await join(); } catch (error) {
          if (error?.code === 'retirement_timeout') { haltBody(bot); throw error; }
          errors.push(error);
        }
      }
      const attempt = async (cleanup) => { try { await cleanup(); } catch (error) { errors.push(error); } };
      for (const behavior of behaviors) await attempt(() => behavior.dispose?.());
      await attempt(() => recovery.dispose());
      if (survey) await attempt(() => releaseSurvey(survey));
      for (const goal of usedGoals) await attempt(() => goal.dispose?.());
      usedGoals.clear();
      goalOwner = null;
      if (bot.companionBodyLife === readBodyLife) {
        if (priorBodyLife) Object.defineProperty(bot, 'companionBodyLife', priorBodyLife);
        else delete bot.companionBodyLife;
      }
      if (bot.companionSelfStuck === selfStuck) bot.companionSelfStuck = priorSelfStuck;
      if (bot.companionHomestead === homestead) {
        if (priorHomestead === undefined) delete bot.companionHomestead;
        else bot.companionHomestead = priorHomestead;
      }
      if (bot.companionHomeTarget === atHome) {
        if (priorHomeTarget === undefined) delete bot.companionHomeTarget;
        else bot.companionHomeTarget = priorHomeTarget;
      }
      if (bot.companionFailureLedger === failureLedger) {
        if (priorFailureLedger === undefined) delete bot.companionFailureLedger;
        else bot.companionFailureLedger = priorFailureLedger;
      }
      if (bot.companionProtectBlock === director.memory.homestead?.memory.protectBlock) {
        if (priorHomeProtection === undefined) delete bot.companionProtectBlock;
        else bot.companionProtectBlock = priorHomeProtection;
      }
      haltBody(bot);
      uninstallOpenDoorPassage(bot, configuredMovements);
      if (errors.length) throw new AggregateError(errors, 'Companion cleanup failed');
    })();
    disposal = operation;
    operation.catch((error) => { if (error?.code === 'retirement_timeout' && disposal === operation) disposal = null; });
    return operation;
  }

  return {
    brain,
    director,
    adaptationReply: (requestId, choice) => !disposed && !survey && director.isEnabled() && Boolean(adaptation?.reply(requestId, choice)),
    ...tasks,
    /** Built-in, data-only dispatch. Resolves at dispatch, not task completion. */
    async submitTask(name, args = {}, metadata = {}) {
      assertActive();
      if (typeof name !== 'string' || !Object.hasOwn(tasks, name)) throw Object.assign(new Error(`Unknown task: ${name}`), { code: 'unknown_task' });
      validateTaskArgs(args);
      return tasks[name](name === 'gatherLogs' ? args.count : args, metadata);
    },
    setGoal(goal, metadata) {
      return startPlayerGoal(() => goal, metadata, false);
    },
    // The host calls these only from its authenticated Mod channel. None are
    // available through submitTask or the model tool schemas.
    prepareSurveyPlan,
    async startSurveyPlan(grant, goal, metadata) {
      const record = survey;
      if (record?.grant !== grant || grant.signal.aborted) return;
      await record.prepared;
      if (survey !== record || grant.signal.aborted) return;
      assertBodyAvailable();
      director.notePlayerGoal();
      useGoal(goal, metadata);
      await brain.tick();
    },
    async stopSurveyPlan(grant, reason) {
      const record = survey;
      if (record?.grant !== grant) return;
      // Mod can revoke the grant before Minecraft delivers the death event.
      if (reason === 'bot_died' && record.lifeEpoch === bodyLifeEpoch) surveyDeathEpoch = bodyLifeEpoch;
      record.closing = true;
      stopSurveyBody();
      if (disposed) { await dispose(); return; }
      await Promise.all([record.prepared, brain.stop(reason)]);
      await joinRetirement();
      // A late-opened window may arrive after the first abort callback.
      stopSurveyBody();
      releaseSurvey(record);
    },
    /** Lets the bot choose its own goals while no player task is set. */
    setAutonomyRange: (range) => director.setRange(range),
    setAutonomy(on) {
      assertActive();
      if (on) assertBodyAvailable();
      if (on && retirementFailed) throw Object.assign(new Error('Goal cleanup failed; dispose this companion'),
        { code: 'cleanup_failed', retryable: false });
      if (on) director.enable();
      else return director.disable();
      return Promise.resolve();
    },
    /** Cancel task/autonomy only; survival and maintenance remain active. */
    async cancelTask(reason = 'task_cancelled', { keepAutonomy = false } = {}) {
      assertActive();
      taskEpoch += 1;
      paused = false;
      await Promise.all([keepAutonomy ? undefined : director.disable(reason), brain.clearGoal(reason)]);
      await joinRetirement();
    },
    /** Suspend task selection and goal work, without suspending safety. */
    async pauseTask(reason = 'task_paused') {
      assertActive();
      paused = true;
      await brain.pauseGoal(reason);
    },
    async resumeTask() {
      assertActive();
      paused = false;
      await brain.resumeGoal();
    },
    /**
     * Set by the model per task: how much risk the stance takes (cautious,
     * normal, bold) and whether a following bot guards the owner before itself.
     * Survival reflexes stay on either way; this only moves their lines.
     */
    setPolicy({ risk, guard } = {}) {
      assertActive();
      if (risk !== undefined) setRisk(risk);
      if (guard !== undefined) { bot.companionGuardOwnerFirst = guard === 'owner_first'; policy.guard = guard; }
      return { ...policy };
    },
    policy: () => ({ ...policy }),
    /** The house this world has (built now or on an earlier connection): its corner and whether it is finished. */
    home() {
      return director?.memory.homestead?.status(perceive(bot)) ?? null;
    },
    /** Legacy stop is not an all-stop: subsequent ticks still run safety. */
    async stop(reason = 'user_stop') {
      assertActive();
      taskEpoch += 1;
      paused = false;
      await Promise.all([director.disable(reason), brain.stop(reason)]);
      await joinRetirement();
      haltBody(bot);
    },
    status: () => ({ ...brain.status(), paused, disposed, cleanupFailed: retirementFailed, recovery: recovery.status(),
      selfStuck: selfStuck.state(), autonomy: director.status(), doctor: doctor.getStatus() }),
    /** Terminal all-stop; construct a new companion to restart. Does not disconnect the bot. */
    stopAll: dispose,
    dispose,
  };
}

// The embedding entry point accepts data, never executable goal definitions or
// dependency overrides. Legacy in-process goal methods remain unrestricted.
function validateTaskArgs(args) {
  const seen = new Set();
  function visit(value) {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('Task arguments must be plain JSON data');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError('Task arguments must be plain JSON data');
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !('value' in descriptor)) throw new TypeError('Task arguments must be plain JSON data');
      visit(descriptor.value);
    }
    seen.delete(value);
  }
  if (!args || Array.isArray(args) || typeof args !== 'object') throw new TypeError('Task arguments must be an object');
  visit(args);
  for (const key of ['bot', 'actions', 'skills', 'kb', '__proto__', 'constructor', 'prototype']) {
    if (Object.hasOwn(args, key)) throw new TypeError(`Task argument is not allowed: ${key}`);
  }
}

module.exports = { createCompanion, configureMovements, nightShelter };

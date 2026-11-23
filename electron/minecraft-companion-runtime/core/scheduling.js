'use strict';

const DEFAULT_TASK_VALUE = 50;
const DANGER = Object.freeze({ health: 6, food: 6, riskyFoodHealth: 8, healingHealth: 10, air: 8, woundedAir: 16 });

function travelTicks(from, to) {
  if (!from || !to) return Infinity;
  // Two blocks per second includes ordinary path detours. Elevation costs more than flat walking.
  return Math.ceil(10 * Math.hypot(from.x - to.x, from.z - to.z) + 20 * Math.abs(from.y - to.y));
}

function nightBudget(state, home) {
  const time = state.timeOfDay;
  const dark = state.isDay === false;
  const ticksToDark = dark ? 0 : Number.isFinite(time) ? (12_542 - time + 24_000) % 24_000 : Infinity;
  const distanceHome = state.position && home ? Math.hypot(state.position.x - home.x, state.position.z - home.z) : 0;
  return { dark, dusk: ticksToDark <= 1_742, ticksToDark, distanceHome, returnTicks: travelTicks(state.position, home) };
}

function schedulingInputs(state, { home, task } = {}) {
  return { state, home, task, ...nightBudget(state, home) };
}

function maintenanceUrgency(name, strength, { state, task, dusk, returnTicks, home }) {
  const hunger = (level) => Math.max(0, level - (state.food ?? 20));
  const injury = Math.max(0, 16 - (state.health ?? 20));
  const nearlyDone = task?.ready && task.remaining <= 2 ? 15 : 0;
  switch (name) {
    case 'night_rest': return strength >= 0.8 ? 150 : 45;
    case 'home_escape': return strength >= 1 ? 155 : 86;
    case 'eat': return 39 + 5 * hunger(18) + 2 * injury - nearlyDone;
    case 'recover': return 52 + 4 * injury - nearlyDone;
    case 'provision':
      if (dusk || task?.returning && state.food > DANGER.food) return 0;
      return Math.max(0, 28 + 7 * hunger(15) + 2 * injury - (home ? Math.min(40, returnTicks / 38) : 0) - nearlyDone);
    case 'home_maintenance': return 30 + 110 * strength - nearlyDone;
    default: return 45 + 45 * strength - nearlyDone;
  }
}

module.exports = { DANGER, DEFAULT_TASK_VALUE, maintenanceUrgency, nightBudget, schedulingInputs, travelTicks };

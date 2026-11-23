'use strict';
// Goal: carry at least `target` pieces of food, hunted from animals.
//
// Each run() hunts one animal; with nothing in sight it explores a little and
// lets the next run look again. Progress is the food count in the bag, so a
// death or an interruption needs no recovery.

const defaultSkills = require('../skills');
const { createForaging, FOOD_MOBS } = require('../work-budget');
const { KNOWLEDGE, countKey } = require('../knowledge');

function createStockFoodGoal({ bot, target = 16, skills = defaultSkills, kb = KNOWLEDGE, radius = 96, home } = {}) {
  if (!Number.isSafeInteger(target) || target < 1) throw new TypeError('target must be a positive integer');
  const forage = createForaging({ bot, skills, home, dropMatch: kb.food.match, targetGoal: 'stock_food' });
  const count = (state) => countKey('food', state.inventory, kb);

  return {
    name: 'stock_food',
    target,
    isDone: (state) => count(state) >= target,
    progress: (state) => count(state),
    run: ctx => forage(ctx, radius),
  };
}

module.exports = { createStockFoodGoal, FOOD_MOBS };

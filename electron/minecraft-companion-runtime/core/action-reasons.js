'use strict';

const RESCUE = new Set(['home_escape', 'unstick', 'surface', 'pit', 'mine_retreat', 'mine_hazard',
  'breathe', 'unbury', 'leave_lava', 'leave_fire', 'leave_danger', 'leave_breath', 'escape']);
const isRescueBehavior = name => RESCUE.has(name);
const FAILURE_WINDOW_MS = 60_000, FAILURE_LIMIT = 20; // Circuit breaker for otherwise unbounded retries.

// Failure producers share these codes. Templates below cover dynamic reasons.
const reasons = Object.freeze({
  // Concrete destination, work cell, target entity, or route-specific failure.
  target: `
    actual_edge_arrival_unconfirmed actual_edge_margin_changed actual_open_unconfirmed adaptation_exhausted
    animal_escaped animal_gone animal_not_following animal_not_inside bastion_unreachable bed_blocked bed_hunt_exhausted
    bed_missing bed_not_used bed_under_low_roof block_changed breach_cell_changed breach_repair_unconfirmed
    bridge_anchor_not_reached bridge_guard_blocked bridge_guard_no_layout bridge_guard_obstructed bridge_guard_portal
    bridge_guard_position_changed bridge_guard_unsafe bridge_height_changed bridge_portal_exit_unavailable
    bridge_route_discontinuous bridge_route_invalid bridge_route_unsafe bridge_step_failed bridge_validate_failed
    bridge_wall build_blocked bunker_spot_changed cage_no_side cane_lost cane_not_growing cannot_dig cart_did_not_move
    cart_failed cart_in_corridor cart_in_entrance cart_not_broken causeway_blocked cave cell_occupied_by_entity
    changed_target chase_stuck chest_empty chest_full chest_missing chest_out_of_reach choose_another_target
    city_blocked city_empty clearance_not_open cliff_overhang cliff_pillar_short cliff_too_high combat_leash combat_timeout
    corridor_full cover_not_cleared depth direction_proposal_changed door_station_unreachable door_unchanged
    doorstep_unreached doorway_not_clear dragon_alive elytra_not_taken end_return_blocked exit_portal_missed
    explore_blocked farm_out_of_sight forbidden_obstacle furniture_blocks_exit fortress_unreachable fresh_natural_shore_and_portal_required
    front_unreached furnace_missing gravity hazard_margin hazard_or_gravity hazard_or_gravity_ore_margin
    hazard_underfloor_margin invalid_mine_approach lava_flowing lava_not_set ledge_blocked ledge_no_land leg_blocked
    line_of_sight_blocked liquid liquid_ahead log_search_exhausted melee_out_of_reach mine_entrance_near_player_build
    mine_entrance_rejected
    mine_exhausted mine_region_avoided mine_route_death_hazard mine_route_fire_hazard mine_route_hazard mob_gone
    model_choice nether_portal_lost no_alternate_stand no_available_mine_entrance no_berries no_bridge_support
    no_bunker_spot no_causeway_target no_column no_confirmed_route no_crop no_firing_spot no_floor no_gate no_gateway_in_sight
    no_grass no_local_seal_material no_mob_in_range no_mold_site no_pearl_spot no_placement_face no_portal_site
    no_pour_face no_progress no_reachable_station no_reachable_villager no_recovery_available no_route_to_cart
    no_shelter_ground no_shore no_side no_site no_source no_spot:furnace no_spot_beside no_stone_here no_storage_site
    no_suitable_site no_supply_chest no_support no_table_spot no_target_in_range no_target_selected no_tower_column
    no_tower_spot no_villager no_way_down no_zombie nopath not_actual_quartz_ore not_arrived not_enough_adults
    not_moved not_owned_home_block not_safe_to_clear occupied ore_front_or_protection_changed ore_not_actual_open pillar_short
    ore_or_open_changed ore_out_of_reach ore_validator_refused ore_validator_required ore_visibility_changed
    out_of_range out_of_reach owner_not_in_sight path_gap path_nopath path_timeout pearl_hop_missed pearl_missed
    piglin_gone piglin_out_of_reach pit_not_filled placement_face_changed placement_station_unreachable pond_not_full
    portal_not_lit portal_radius portal_room_unreachable portal_unavailable protected_home protected_ore_or_route_floor
    protected_player_block quartz_direction_proposal_changed quartz_direction_proposal_invalid
    quartz_drop_not_safely_collectable quartz_excavation_budget_or_targets_exhausted quartz_excavation_no_safe_heading
    quartz_excavation_route_unconfirmed quartz_no_reachable_target quartz_no_safe_frontier
    quartz_shore_arrival_unconfirmed quartz_target_changed rail_cell_blocked relocation_not_arrived restock_not_arrived
    reverse_clearance_changed reverse_edge_no_longer_safe reverse_margin_changed revisited_route_refused
    roof_step_unavailable roof_wood_cap_still_present roof_wood_cleanup_blocked roof_wood_cover_unavailable
    roof_wood_no_support roof_wood_opening_changed roof_wood_panel_changed roof_wood_unsafe_stand route_region_avoided
    search_exhausted search_leg_budget shelter_wall_open shore_body_sweep_unsafe shore_natural_patch_unconfirmed shore_no_path
    shore_route_unsafe shulker_survived site_changed site_rejected spawner_unreachable spiral_place_failed spiral_step_failed
    station_out_of_reach survey_adjacent_fluid survey_cross_boundary_tree survey_falling_column
    survey_outside_attachment survey_site_changed table_missing target_excluded target_lost target_unreachable timeout
    target_needs_breath target_near_lava target_near_fire target_causes_suffocation
    tower_not_reached tower_short unconfirmed_cave_at_ore undiggable unknown_block unsafe_excavation unsafe_full_floor
    unreachable unsafe_stance unsafe_support_dig villager_in_entrance villager_moved villager_not_aboard walk_blocked
    worksite_unreachable
  `,
  // Body or starting position prevents making the attempt.
  start: `
    bridge_guard_body bridge_not_grounded bridge_origin_changed cage_climb_short edge_in_flight escape_step_unconfirmed
    food_retreat health_retreat home_access_repair_unconfirmed home_entry_obstructed
    home_entry_support_missing home_escape_unconfirmed home_exit_blocked home_origin_unrecovered in_lava
    interior_cut_off log_scout_trapped log_scout_water_entered log_water_no_shore
    log_water_recovery_timeout low_health mine_exit_blocked mine_exit_not_arrived not_at_column not_at_confirmed_front
    not_at_doorway not_in_stand not_in_water not_on_hole off_confirmed_route off_deck path_first_step quartz_not_grounded
    quartz_origin_changed quartz_shore_not_centered self_escape_unconfirmed self_stuck shelter_not_entered
    shore_not_actual_grounded shore_not_grounded shore_position_changed shore_unreached standing_on_scaffold
    still_below_surface still_buried still_in_shelter still_underwater stuck thrown_off tower_off_deck trapped_in_device
    unsafe_build_stand unsafe_escape_step walk_profile_or_ground
  `,
  // Inventory does not meet the requirements of the proposed action.
  material: `
    bed_materials_unavailable causeway_blocks end_departure_requirements few_blocks ledge_no_blocks missing_breach_repair_material
    missing_flint_and_steel missing_ingredients missing_obsidian needs_supplies needs_usable_pickaxe
    nether_departure_requirements no_arrows no_bow no_bridge_blocks no_bucket no_diamond_pickaxe no_eye no_eyes no_food
    no_farmland_near_home no_fuel no_gold no_gold_armour no_golden_apple no_hoe no_igniter no_material no_pearl no_pearls no_pickaxe no_potion
    no_seal_block no_seeds no_shield no_spare_pickaxe no_step_block no_tool no_weapon not_enough_eyes
    roof_step_needs_filler route_floor_missing_material tower_blocks
  `,
  // Ownership, intent, or the active journey changed.
  interrupted: `
    aborted combat_yielded disconnected goalchanged guard_leash home_site_relocated mining_goal_changed owner_moved pathstopped
    profile_owner_changed quartz_life_changed quartz_profile_changed query_context_changed survey_unauthorized
    threat_cleared trip_recovery_owned
  `,
  // Observation, bounds, server confirmation, or action environment prevented completion.
  environment: `
    action_failed actual_held_tool_unconfirmed adaptation_other_work awaiting_villagers bed_explodes_here behavior_error
    berries_unconfirmed bridge_guard_changed bridge_guard_partial bridge_guard_place_failed bridge_guard_unknown
    bridge_inspection_reentrant bridge_observation_changed bridge_place_failed bridge_prepare_failed
    bridge_recovery_unavailable bridge_return_not_confirmed bridge_route_unknown bridge_step_unconfirmed bucket_unfilled
    cast_failed catch_not_collected chest_failed chest_unconfirmed construction_error craft_unconfirmed
    crafting_grid_unconfirmed crystal_missed death_in_mine dig_unconfirmed drink_unconfirmed drop_not_collected
    drops_not_collected eat_unconfirmed egg_failed equip_failed excavation_budget_retreat excavation_dig_budget
    eye_did_not_move eye_not_seen fire_in_mine frame_not_filled fresh_validator_refused furnace_open_failed
    gate_unconfirmed goal_methods_exhausted gold_lost gold_not_taken heartbeat_failed home_access_requires_owner
    invalid_cardinal_direction invalid_known_route_direction invalid_target_selection known_edge_budget
    known_route_front_required left_overworld line_of_sight_unknown loot_not_picked maintenance_timeout mine_chunk_unloaded
    mine_entrance_cooling mining_goal_unconfirmed missed misplacement_retries_exhausted missing_native_exclusion_hooks
    native_dig_contract_missing native_look_dispatch_contract_missing no_baby no_bite no_golem_yet no_mobs_yet
    no_native_planner no_observed_change no_regeneration no_string_collected no_wool_collected not_hungry not_in_end
    not_in_overworld not_picked nothing_to_discard nothing_to_do nothing_to_store overworld_death path_budget path_context_changed
    path_context_missing path_failed path_mutation path_partial path_query_error path_slice_budget path_total_deadline
    path_world_changed piston_not_firing place_unconfirmed placement_unconfirmed plant_unconfirmed portal_no_transfer
    post_dig_validator_refused pour_unconfirmed press_failed quartz_excavation_pending quartz_excavation_unavailable
    quartz_frontier_pending quartz_pickup_unobserved quartz_retirement_pending quartz_scan_pending
    quartz_search_inconclusive quartz_target_unknown query_shore_unconfirmed relocation_routes_exhausted
    result_reason_unmapped return_reserve_required roof_step_unconfirmed roof_wood_cap_unconfirmed
    roof_wood_replacement_unconfirmed route_floor_unconfirmed scaffold_unloaded scoop_unconfirmed shore_no_movements
    shore_route_budget shore_route_timeout shore_route_unconfirmed shore_route_unknown shore_step_unconfirmed smelt_failed smelt_no_output
    survey_custom_item_data survey_door_unconfirmed survey_door_unsent survey_interaction_busy
    survey_movement_unavailable survey_night survey_place_unsent survey_preparation_failed survey_unauthorized_door
    survey_wrong_operation take_unconfirmed till_unconfirmed tool_equip_failed toss_failed toss_unconfirmed toss_unseen
    unknown unknown_cave unknown_clearance unknown_dig_cell unknown_item unknown_margin unknown_ore unknown_ore_margin
    unknown_target_geometry unknown_underfloor_margin unloaded villagers_walking waiting walk_profile_changed
    world_changed world_or_dimension_changed wrong_dimension
  `,
});

const exact = new Map(Object.entries(reasons).flatMap(([kind, codes]) =>
  codes.trim().split(/\s+/).map(reason => [reason, kind])));
const templates = [
  [/^none_near_site:.+$/, 'target'],
  [/^exhausted:.+$/, 'target'],
  [/^mine_blocked:.+$/, 'target'],
  [/^unplannable:[^:]+:.+$/, 'environment'],
  [/^needs_dimension:(?:overworld|the_nether|the_end)$/, 'environment'],
  [/^no_station:(?:crafting_table|furnace|smoker|blast_furnace)$/, 'environment'],
  [/^no_(?:table|furnace|smoker|blast_furnace)_spot$/, 'target'],
  [/^no_[a-z_]+_this_press$/, 'target'],
  [/^topology_.+$/, reason => classifyReason(reason.slice('topology_'.length))],
];

function classifyReason(reason) {
  const kind = typeof reason === 'string' && exact.get(reason.toLowerCase());
  if (kind) return kind;
  const template = typeof reason === 'string' && templates.find(([pattern]) => pattern.test(reason));
  if (template) return typeof template[1] === 'function' ? template[1](reason) : template[1];
  throw Object.assign(new RangeError(`Unclassified action failure: ${String(reason)}`), {
    code: 'result_reason_unmapped', reason,
  });
}

const isComplete = result => result?.ok === true && !result.wait;

module.exports = { classifyReason, FAILURE_LIMIT, FAILURE_WINDOW_MS, isComplete, isRescueBehavior, reasons, templates };

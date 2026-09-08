/**
 * The availability finder's horizon.
 *
 * `find_available_slots` refuses `(p_to - p_from) > 13`, so the inclusive span
 * is 14 days. Kept here rather than in the action module because a "use server"
 * file may only export async functions, and both the form and the action need
 * this number.
 */
export const MAX_RANGE_DAYS = 14;

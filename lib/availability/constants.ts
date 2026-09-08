/**
 * The availability finder's horizon.
 *
 * `find_available_slots` refuses `(p_to - p_from) > 13`, so the inclusive span
 * is 14 days. Kept here rather than in the action module because a "use server"
 * file may only export async functions, and both the form and the action need
 * this number.
 */
export const MAX_RANGE_DAYS = 14;

/**
 * The workspace the customer-facing availability message speaks for.
 *
 * V1 convention. `workspaces` has no is_private or is_customer_facing column,
 * so the slug is the closest thing to a stable marker — matching on the display
 * name would be worse, because names are meant to be editable. A Master who can
 * see only one workspace uses that one, so this only ever decides the case
 * where several are visible.
 *
 * Worth replacing with a real column when Settings lands.
 */
export const OPERATIONAL_WORKSPACE_SLUG = "shared-team";

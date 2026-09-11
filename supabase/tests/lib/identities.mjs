// The fixture identity model, in one place.
//
// The seeder creates it and the harness resolves it, so it is defined once and
// imported by both. When these drifted apart they drifted silently: a suite
// looked up a name the seed had never created and failed with "fixture identity
// missing", which reads like a broken database rather than a typo.
//
// Every address is synthetic. `.test` is a reserved TLD that cannot resolve, so
// none of these can receive mail, and no real person's credentials appear here.
//
// The shape mirrors the product's authorization model:
//
//   KC     super_master   — masters BOTH workspaces
//   Nick   partner_master — masters Shared Team only
//   Jack   staff          — bookable, Shared Team
//   Dyron  staff          — bookable, Shared Team
//   Victor staff          — bookable, KC Private Team ONLY
//
// Nick masters Shared Team and nothing else, and Victor is a member of nothing
// but KC Private Team. That is what makes "Nick must not know Victor exists" a
// property of the data rather than of the UI.

export const WORKSPACES = [
  { key: 'shared', name: 'Shared Team', slug: 'shared-team' },
  { key: 'private', name: 'KC Private Team', slug: 'kc-private-team' },
];

export const IDENTITIES = [
  {
    key: 'kc', fullName: 'TEST_KC', email: 'test-kc@mrcleanclean.dev.test',
    role: 'super_master', staff: false, masters: ['shared', 'private'], memberOf: [],
  },
  {
    key: 'nick', fullName: 'TEST_NICK', email: 'test-nick@mrcleanclean.dev.test',
    role: 'partner_master', staff: false, masters: ['shared'], memberOf: [],
  },
  {
    key: 'jack', fullName: 'TEST_JACK', email: 'test-jack@mrcleanclean.dev.test',
    role: 'staff', staff: true, masters: [], memberOf: ['shared'],
  },
  {
    key: 'dyron', fullName: 'TEST_DYRON', email: 'test-dyron@mrcleanclean.dev.test',
    role: 'staff', staff: true, masters: [], memberOf: ['shared'],
  },
  {
    key: 'victor', fullName: 'TEST_VICTOR', email: 'test-victor@mrcleanclean.dev.test',
    role: 'staff', staff: true, masters: [], memberOf: ['private'],
  },
];

/** key -> email, the shape `signInAll` wants. */
export const EMAIL_BY_KEY = Object.fromEntries(IDENTITIES.map((i) => [i.key, i.email]));

/** The singleton business settings row, matching the DEV baseline. */
export const BUSINESS_SETTINGS = {
  rm_per_hour_rate: 200.00,
  full_day_lock_threshold: 600.00,
  default_availability_job_duration_minutes: 60,
  default_buffer_minutes: 30,
  default_day_start: '09:00:00',
  default_day_end: '19:00:00',
  staff_can_mark_completed: true,
};

/** Company-wide suggested times offered in the booking UI. */
export const SUGGESTED_TIME_SLOTS = [
  { slot_time: '10:00:00', sort_order: 0 },
  { slot_time: '13:00:00', sort_order: 1 },
  { slot_time: '15:00:00', sort_order: 2 },
];

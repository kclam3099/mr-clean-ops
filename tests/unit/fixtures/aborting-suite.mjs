// A synthetic suite that dies halfway through, for the harness regression.
//
// Shaped exactly like a real browser suite: declare a plan, run some checks,
// throw from the middle of the body, clean up in `finally`, and report. It runs
// as a CHILD PROCESS so the assertion can be about the real exit code rather
// than about what a function returned — an exit code is what CI actually reads,
// and it was the thing that lied.
//
// Not named *.test.mjs on purpose: the unit runner must not collect it.

import { createRecorder } from '../../../supabase/tests/lib/harness.mjs';

const rec = createRecorder('SYNTHETIC ABORTING SUITE');
const shouldThrow = process.env.SYNTHETIC_THROW !== 'no';

// Four checks intended. Two run before the fixture dies.
rec.plan(4);

let cleanedUp = false;
try {
  rec.check({ id: 'S-01 first', action: 'a', expected: 'x', actual: 'x', ok: true });
  rec.check({ id: 'S-02 second', action: 'b', expected: 'y', actual: 'y', ok: true });

  if (shouldThrow) {
    // Stands in for the real thing: a fixture insert that hit
    // no_overlapping_staff_bookings because an earlier section had already
    // claimed that slot.
    throw new Error('synthetic fixture failure: conflicting key value violates exclusion constraint');
  }

  rec.check({ id: 'S-03 third', action: 'c', expected: 'z', actual: 'z', ok: true });
  rec.check({ id: 'S-04 fourth', action: 'd', expected: 'w', actual: 'w', ok: true });
} catch (e) {
  rec.aborted(e);
} finally {
  cleanedUp = true;
  console.log(`synthetic cleanup ran: ${cleanedUp}`);
  rec.finish();
}

// Error-mapping coverage.
//
// Enumerates every `raise exception` message in every APPLICATION function on
// DEV and asserts the privacy-safe mapper recognises each one. An unrecognised
// message is not a crash — it renders "Something went wrong. Please try again."
// and the user loses whatever they were doing with no idea why.
//
// This found 15 unmapped messages when first written, four of them on the
// appointment lifecycle path, plus a rule-ordering bug where
// "Only a Master may set staff time off" (an authorization failure) was
// reported as "This team member is on time off then."
//
// The suite is deliberately generated from the database rather than a hand
// list, so a message added by a future migration shows up here immediately.
//
// Run: npm run test:error-mapping

import { runSuite } from "./lib/harness.mjs";
import { toAppError, AppErrorCode } from "../../lib/errors/appError.ts";

/** Fill in printf placeholders so the mapper sees a realistic message. */
function realistic(message) {
  return message
    .replace("(% to %)", "(09:00:00 to 19:00:00)")
    .replace(/ at %/, " at 10:00:00")
    .replace(/ starting %/, " starting 10:00:00")
    .replace(/%/g, "x");
}

const summary = await runSuite("ERROR-MAPPING COVERAGE", async ({ fx, rec }) => {
  const fns = await fx.query(`
    select p.proname, pg_get_functiondef(p.oid) def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and p.proname not like 'gbt%' and p.proname not like '%_dist'
     order by p.proname`);

  const messages = new Map();
  for (const f of fns) {
    for (const m of f.def.matchAll(/raise exception\s+'((?:[^']|'')*)'/gi)) {
      const msg = m[1].replace(/''/g, "'");
      if (!messages.has(msg)) messages.set(msg, new Set());
      messages.get(msg).add(f.proname);
    }
  }

  rec.check({
    id: "EM-00 messages discovered", actor: "db", setup: "all application functions",
    action: "extract every raise exception message",
    expected: "a non-trivial set — an empty one would make this suite vacuous",
    actual: `${messages.size} distinct messages across ${fns.length} functions`,
    ok: messages.size >= 30 && fns.length >= 15,
  });

  const unmapped = [];
  for (const [msg, where] of messages) {
    const mapped = toAppError({ message: realistic(msg) });
    if (mapped.code === AppErrorCode.UNEXPECTED) unmapped.push({ msg, where: [...where] });
  }
  rec.check({
    id: "EM-01 every backend message is mapped (CRITICAL)", actor: "mapper",
    setup: `${messages.size} distinct messages`,
    action: "map each one",
    expected: "none fall through to UNEXPECTED",
    actual: unmapped.length
      ? `${unmapped.length} UNMAPPED: ${unmapped.map((u) => `"${u.msg.slice(0, 40)}" (${u.where.join(", ")})`).join(" | ")}`
      : "all mapped",
    ok: unmapped.length === 0,
  });

  // Specific mappings that carry meaning, asserted individually so a
  // regression names the case rather than just the count.
  const EXPECTED = [
    ["STAFF_UNAVAILABLE", AppErrorCode.STAFF_UNAVAILABLE],
    ["Appointment not found", AppErrorCode.NOT_AUTHORIZED],
    ["Not your appointment", AppErrorCode.NOT_AUTHORIZED],
    ["Staff completion is currently disabled in Settings", AppErrorCode.NOT_AUTHORIZED],
    ["Appointment must be in the future", AppErrorCode.PAST_DATETIME],
    ["Only a Master may set staff time off", AppErrorCode.NOT_AUTHORIZED],
    ["Only a Master may remove staff time off", AppErrorCode.NOT_AUTHORIZED],
    ["Staff is unavailable during this time (time off)", AppErrorCode.TIME_OFF],
    ["Staff has upcoming booked appointments — reassign or cancel them first",
      AppErrorCode.BLOCKING_APPOINTMENTS],
    ["Only a booked appointment can be cancelled", AppErrorCode.INVALID_APPOINTMENT_STATE],
    ["Range too large", AppErrorCode.VALIDATION_ERROR],
  ];
  for (const [msg, expected] of EXPECTED) {
    const got = toAppError({ message: msg });
    rec.check({
      id: `EM-02 "${msg.slice(0, 44)}"`, actor: "mapper", setup: "-",
      action: "map the message", expected,
      actual: got.code, ok: got.code === expected,
    });
  }

  // The two lookup failures must be indistinguishable — otherwise the error
  // itself confirms that an appointment exists.
  const notFound = toAppError({ message: "Appointment not found" });
  const notYours = toAppError({ message: "Not your appointment" });
  rec.check({
    id: "EM-03 not-found and not-yours are indistinguishable (CRITICAL)", actor: "mapper",
    setup: "a guessed uuid vs someone else's appointment",
    action: "compare the mapped results",
    expected: "identical code, message and detail",
    actual: JSON.stringify(notFound) === JSON.stringify(notYours)
      ? "identical" : `${JSON.stringify(notFound)} vs ${JSON.stringify(notYours)}`,
    ok: JSON.stringify(notFound) === JSON.stringify(notYours), security: true,
  });

  // No mapped message may echo server text.
  const leaky = [...messages.keys()].filter((msg) => {
    const mapped = toAppError({ message: realistic(msg) });
    return mapped.message === realistic(msg);
  });
  rec.check({
    id: "EM-04 no mapped message echoes server text (CRITICAL)", actor: "mapper",
    setup: `${messages.size} messages`,
    action: "compare each safe message against its raw source",
    expected: "never equal",
    actual: leaky.length ? `ECHOED: ${leaky.join(", ")}` : "none echoed",
    ok: leaky.length === 0, security: true,
  });
});

process.exit(summary.fail === 0 ? 0 : 1);

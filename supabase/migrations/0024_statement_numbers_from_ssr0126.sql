-- 0024 — contractor statement numbers continue from SSR0126
--
-- Owner's rule (2026-10-03): the statement series continues the numbering
-- already in use outside the app, starting at SSR0126. The counter only ever
-- moves forward, so re-running this is harmless.

update public.statement_counter
   set next_number = greatest(next_number, 126)
 where id;

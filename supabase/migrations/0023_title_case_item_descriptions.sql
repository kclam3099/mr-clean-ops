-- 0023 — service and add-on descriptions are stored in Title Case
--
-- Owner's rule (2026-10-03): descriptions arrive pasted from WhatsApp in any
-- case — "king size bed", "SOFA 3 SEATER", "Queen SIZE" — and should read
-- "King Size Bed", "Sofa 3 Seater", "Queen Size": first letter of each word
-- upper case, the rest lower case.
--
-- Done in the database, with a BEFORE trigger, so every way in is covered:
-- Quick Add, the booking form, "Edit services", add-ons, and anything added
-- later — and nothing in the browser has to remember to do it.
--
-- Not Postgres's initcap(): it treats an apostrophe as a word break and would
-- write "Children'S". Here a letter is capitalised only when the character
-- before it is not a letter, digit or apostrophe; non-Latin text (Chinese)
-- has no case and passes through unchanged. Whitespace is kept as typed apart
-- from trimming the ends. "RM" before an amount and the quantity "x" before a
-- number keep their usual form.

create or replace function public.title_case(p_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out  text := '';
  v_prev text := ' ';
  v_ch   text;
  v_in   text := btrim(coalesce(p_text, ''));
begin
  if p_text is null then
    return null;
  end if;
  for i in 1 .. char_length(v_in) loop
    v_ch := substr(v_in, i, 1);
    if v_prev ~ '[[:alnum:]'']' then
      v_out := v_out || lower(v_ch);
    else
      v_out := v_out || upper(v_ch);
    end if;
    v_prev := v_ch;
  end loop;
  -- Two tokens keep their own case: the currency ("RM159", "RM 99") and the
  -- quantity "x" ("Sofa x2", "Curtain x 3") — "Rm159" and "Sofa X2" read wrong.
  v_out := regexp_replace(v_out, '\mRm(?=\s*\d|\M)', 'RM', 'g');
  v_out := regexp_replace(v_out, '\mX(?=\s*\d)', 'x', 'g');
  return v_out;
end;
$$;

create or replace function public.trg_title_case_description()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.description := public.title_case(new.description);
  return new;
end;
$$;

drop trigger if exists trg_title_case_item_description on public.appointment_items;
create trigger trg_title_case_item_description
  before insert or update of description on public.appointment_items
  for each row
  execute function public.trg_title_case_description();

drop trigger if exists trg_title_case_addon_description on public.appointment_addons;
create trigger trg_title_case_addon_description
  before insert or update of description on public.appointment_addons
  for each row
  execute function public.trg_title_case_description();

revoke all on function public.trg_title_case_description() from public, anon, authenticated;
grant execute on function public.title_case(text) to authenticated;

-- Existing rows, once. Runs without a session, so the staff edit-window
-- triggers (which only restrict a staff caller) do not apply.
update public.appointment_items set description = description where description is distinct from public.title_case(description);
update public.appointment_addons set description = description where description is distinct from public.title_case(description);

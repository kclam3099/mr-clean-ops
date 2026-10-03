-- 0022 — Statements of Services Rendered (contractor payment statements)
--
-- KC pays Jack, Dyron and Victor as independent outsourced contractors, by
-- bank transfer, monthly. This adds the document that goes with the payment:
-- a Statement of Services Rendered listing the work, the gross fee, any
-- deductions and the net amount paid, with a receipt acknowledgement the
-- contractor signs.
--
-- SUPER MASTER ONLY, at the database. Contractor identity numbers (IC /
-- passport) and what each person is paid are KC's alone: not Nick's, not the
-- staff's. Every table here is readable only when my_role() = 'super_master',
-- and every write goes through a function that checks the same. Hiding the
-- menu item would not be enough; this is the rule.
--
-- contractor_profiles  legal name, IC/passport, contact — one row per staff.
-- contractor_statements one statement each; the contractor's details are
--                      COPIED onto it when saved, so a statement keeps saying
--                      what it said even if the profile changes later.
-- statement_counter    SSR0001, SSR0002, … assigned on first save, never
--                      reused (a deleted statement leaves a gap, like invoices).
--
-- Permission checks are NULL-safe (see 0017): coalesce(..., false).

create table if not exists public.contractor_profiles (
  staff_id    uuid primary key references public.staff(id) on delete cascade,
  legal_name  text check (legal_name is null or char_length(legal_name) <= 200),
  id_number   text check (id_number is null or char_length(id_number) <= 40),
  phone       text check (phone is null or char_length(phone) <= 40),
  address     text check (address is null or char_length(address) <= 300),
  updated_by  uuid references public.profiles(id),
  updated_at  timestamptz not null default now()
);
alter table public.contractor_profiles enable row level security;
create policy contractor_profiles_super_master on public.contractor_profiles
  for select using (coalesce(public.my_role() = 'super_master'::public.user_role, false));
revoke all on public.contractor_profiles from anon;

create table if not exists public.statement_counter (
  id          boolean primary key default true check (id),
  next_number integer not null check (next_number > 0)
);
insert into public.statement_counter (id, next_number) values (true, 1) on conflict (id) do nothing;
alter table public.statement_counter enable row level security;
revoke all on public.statement_counter from anon, authenticated;

create table if not exists public.contractor_statements (
  id                   uuid primary key default gen_random_uuid(),
  statement_number     integer not null unique check (statement_number > 0),
  statement_no         text generated always as (
                         'SSR' || case when statement_number < 10000
                                       then lpad(statement_number::text, 4, '0')
                                       else statement_number::text end
                       ) stored,
  staff_id             uuid not null references public.staff(id),
  issue_date           date not null,
  period_from          date,
  period_to            date,
  contractor_name      text not null check (char_length(btrim(contractor_name)) between 1 and 200),
  contractor_id_number text check (contractor_id_number is null or char_length(contractor_id_number) <= 40),
  contractor_contact   text check (contractor_contact is null or char_length(contractor_contact) <= 200),
  lines                jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 60),
  gross_total          numeric(12,2) not null check (gross_total >= 0),
  deductions           jsonb not null default '[]'::jsonb check (jsonb_typeof(deductions) = 'array' and jsonb_array_length(deductions) <= 10),
  deduction_total      numeric(12,2) not null default 0 check (deduction_total >= 0),
  net_amount           numeric(12,2) not null check (net_amount >= 0),
  payment_method       text check (payment_method is null or char_length(payment_method) <= 60),
  payment_reference    text check (payment_reference is null or char_length(payment_reference) <= 200),
  payment_date         date,
  created_by           uuid not null references public.profiles(id),
  created_at           timestamptz not null default now(),
  updated_by           uuid references public.profiles(id),
  updated_at           timestamptz,
  constraint contractor_statements_period check (period_from is null or period_to is null or period_to >= period_from)
);
alter table public.contractor_statements enable row level security;
create policy contractor_statements_super_master on public.contractor_statements
  for select using (coalesce(public.my_role() = 'super_master'::public.user_role, false));
revoke all on public.contractor_statements from anon;
create index if not exists contractor_statements_staff_idx on public.contractor_statements (staff_id, issue_date);

-- ---------------------------------------------------------------------------
create or replace function public.save_contractor_profile(
  p_staff_id uuid, p_legal_name text, p_id_number text, p_phone text, p_address text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce(auth.uid() is not null and public.my_role() = 'super_master'::public.user_role, false) then
    raise exception 'Not authorized';
  end if;
  if not exists (select 1 from public.staff where id = p_staff_id) then
    raise exception 'Not authorized';
  end if;
  if char_length(coalesce(p_legal_name, '')) > 200 or char_length(coalesce(p_id_number, '')) > 40
     or char_length(coalesce(p_phone, '')) > 40 or char_length(coalesce(p_address, '')) > 300 then
    raise exception 'Statement details are invalid';
  end if;

  insert into public.contractor_profiles (staff_id, legal_name, id_number, phone, address, updated_by, updated_at)
  values (p_staff_id, nullif(btrim(p_legal_name), ''), nullif(btrim(p_id_number), ''),
          nullif(btrim(p_phone), ''), nullif(btrim(p_address), ''), auth.uid(), now())
  on conflict (staff_id) do update set
    legal_name = excluded.legal_name, id_number = excluded.id_number, phone = excluded.phone,
    address = excluded.address, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Create (p_statement_id null — takes the next SSR number) or update one.
-- lines:      [{ "date": "YYYY-MM-DD", "description": text, "amount": n }]
-- deductions: [{ "label": text, "amount": n }]
-- Totals are computed here, never trusted from the caller.
create or replace function public.save_contractor_statement(
  p_statement_id      uuid,
  p_staff_id          uuid,
  p_issue_date        date,
  p_period_from       date,
  p_period_to         date,
  p_contractor_name   text,
  p_contractor_id     text,
  p_contractor_contact text,
  p_lines             jsonb,
  p_deductions        jsonb,
  p_payment_method    text,
  p_payment_reference text,
  p_payment_date      date
)
returns table (statement_id uuid, statement_no text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lines     jsonb := '[]'::jsonb;
  v_deds      jsonb := '[]'::jsonb;
  v_el        jsonb;
  v_text      text;
  v_amount    numeric;
  v_day       date;
  v_gross     numeric := 0;
  v_ded_total numeric := 0;
  v_number    integer;
  v_id        uuid;
begin
  if not coalesce(auth.uid() is not null and public.my_role() = 'super_master'::public.user_role, false) then
    raise exception 'Not authorized';
  end if;
  if not exists (select 1 from public.staff where id = p_staff_id) then
    raise exception 'Not authorized';
  end if;

  if p_issue_date is null
     or char_length(btrim(coalesce(p_contractor_name, ''))) not between 1 and 200
     or char_length(coalesce(p_contractor_id, '')) > 40
     or char_length(coalesce(p_contractor_contact, '')) > 200
     or char_length(coalesce(p_payment_method, '')) > 60
     or char_length(coalesce(p_payment_reference, '')) > 200
     or (p_period_from is not null and p_period_to is not null and p_period_to < p_period_from)
     or p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 60
     or (p_deductions is not null and (jsonb_typeof(p_deductions) <> 'array' or jsonb_array_length(p_deductions) > 10)) then
    raise exception 'Statement details are invalid';
  end if;

  for v_el in select * from jsonb_array_elements(p_lines) loop
    v_text := btrim(coalesce(v_el->>'description', ''));
    begin
      v_amount := round((v_el->>'amount')::numeric, 2);
      v_day := nullif(v_el->>'date', '')::date;
    exception when others then
      raise exception 'Statement details are invalid';
    end;
    if char_length(v_text) not between 1 and 300 or v_amount is null or v_amount < 0 or v_amount > 1000000 then
      raise exception 'Statement details are invalid';
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('date', v_day, 'description', v_text, 'amount', v_amount));
    v_gross := v_gross + v_amount;
  end loop;

  for v_el in select * from jsonb_array_elements(coalesce(p_deductions, '[]'::jsonb)) loop
    v_text := btrim(coalesce(v_el->>'label', ''));
    begin
      v_amount := round((v_el->>'amount')::numeric, 2);
    exception when others then
      raise exception 'Statement details are invalid';
    end;
    if char_length(v_text) not between 1 and 120 or v_amount is null or v_amount < 0 then
      raise exception 'Statement details are invalid';
    end if;
    v_deds := v_deds || jsonb_build_array(jsonb_build_object('label', v_text, 'amount', v_amount));
    v_ded_total := v_ded_total + v_amount;
  end loop;

  if v_ded_total > v_gross then
    raise exception 'Statement details are invalid';
  end if;

  if p_statement_id is not null then
    update public.contractor_statements set
      staff_id = p_staff_id, issue_date = p_issue_date, period_from = p_period_from, period_to = p_period_to,
      contractor_name = btrim(p_contractor_name),
      contractor_id_number = nullif(btrim(coalesce(p_contractor_id, '')), ''),
      contractor_contact = nullif(btrim(coalesce(p_contractor_contact, '')), ''),
      lines = v_lines, gross_total = v_gross, deductions = v_deds, deduction_total = v_ded_total,
      net_amount = v_gross - v_ded_total,
      payment_method = nullif(btrim(coalesce(p_payment_method, '')), ''),
      payment_reference = nullif(btrim(coalesce(p_payment_reference, '')), ''),
      payment_date = p_payment_date,
      updated_by = auth.uid(), updated_at = now()
    where id = p_statement_id;
    if not found then
      raise exception 'Not authorized';
    end if;
    return query select s.id, s.statement_no from public.contractor_statements s where s.id = p_statement_id;
    return;
  end if;

  select c.next_number into v_number from public.statement_counter c where c.id for update;
  update public.statement_counter set next_number = v_number + 1 where id;

  insert into public.contractor_statements (
    statement_number, staff_id, issue_date, period_from, period_to, contractor_name,
    contractor_id_number, contractor_contact, lines, gross_total, deductions, deduction_total,
    net_amount, payment_method, payment_reference, payment_date, created_by
  ) values (
    v_number, p_staff_id, p_issue_date, p_period_from, p_period_to, btrim(p_contractor_name),
    nullif(btrim(coalesce(p_contractor_id, '')), ''), nullif(btrim(coalesce(p_contractor_contact, '')), ''),
    v_lines, v_gross, v_deds, v_ded_total, v_gross - v_ded_total,
    nullif(btrim(coalesce(p_payment_method, '')), ''), nullif(btrim(coalesce(p_payment_reference, '')), ''),
    p_payment_date, auth.uid()
  )
  returning id into v_id;

  return query select s.id, s.statement_no from public.contractor_statements s where s.id = v_id;
end;
$$;

create or replace function public.delete_contractor_statement(p_statement_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce(auth.uid() is not null and public.my_role() = 'super_master'::public.user_role, false) then
    raise exception 'Not authorized';
  end if;
  delete from public.contractor_statements where id = p_statement_id;
  if not found then
    raise exception 'Not authorized';
  end if;
end;
$$;

revoke all on function public.save_contractor_profile(uuid, text, text, text, text) from public, anon;
grant execute on function public.save_contractor_profile(uuid, text, text, text, text) to authenticated;
revoke all on function public.save_contractor_statement(uuid, uuid, date, date, date, text, text, text, jsonb, jsonb, text, text, date) from public, anon;
grant execute on function public.save_contractor_statement(uuid, uuid, date, date, date, text, text, text, jsonb, jsonb, text, text, date) to authenticated;
revoke all on function public.delete_contractor_statement(uuid) from public, anon;
grant execute on function public.delete_contractor_statement(uuid) to authenticated;

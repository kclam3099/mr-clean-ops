-- 0018 — invoices
--
-- One invoice per completed appointment, numbered from ONE company-wide series
-- (MRC0624, MRC0625, …) shared by every staff member and workspace, as the
-- owner keeps it today in Google Sheets. The number is assigned once, on first
-- save, and never changes; later saves edit the details only.
--
-- WHO. The assigned staff member, or a Master of the appointment's workspace —
-- the same people who can see the appointment — and only once the job is
-- marked completed. The person requesting may correct the bill-to name,
-- address, service line and items before the invoice is produced.
--
-- THE NUMBER. invoice_counter holds the next number; save_invoice takes it
-- under a row lock, so two people invoicing at the same moment get two
-- different consecutive numbers, never the same one and never a gap from a
-- failed save (the counter only advances in the same transaction as the
-- insert). It starts at 624: the owner's sheet ends at MRC0623.
--
-- A NOTE ON PRIVACY, accepted by the owner: one shared series means a Master
-- who sees only Shared Team invoices will notice gaps where another
-- workspace's invoices took numbers. The gap carries no customer, amount or
-- workspace name — only that numbers were used elsewhere.
--
-- WRITES go only through save_invoice. No INSERT/UPDATE/DELETE policy exists.

create table if not exists public.invoice_counter (
  id          boolean primary key default true check (id),
  next_number integer not null check (next_number > 0)
);
insert into public.invoice_counter (id, next_number) values (true, 624)
on conflict (id) do nothing;
alter table public.invoice_counter enable row level security;
revoke all on public.invoice_counter from anon, authenticated;

create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null unique references public.appointments(id) on delete restrict,
  invoice_number  integer not null unique check (invoice_number > 0),
  invoice_no      text generated always as (
                    'MRC' || case when invoice_number < 10000
                                  then lpad(invoice_number::text, 4, '0')
                                  else invoice_number::text end
                  ) stored,
  invoice_date    date not null,
  bill_to_name    text not null check (char_length(btrim(bill_to_name)) between 1 and 200),
  bill_to_address text check (bill_to_address is null or char_length(bill_to_address) <= 500),
  service_title   text check (service_title is null or char_length(service_title) <= 200),
  items           jsonb not null check (jsonb_typeof(items) = 'array'
                                        and jsonb_array_length(items) between 1 and 12),
  discount_label  text check (discount_label is null or char_length(discount_label) <= 40),
  discount_amount numeric(10,2) not null default 0 check (discount_amount >= 0),
  total           numeric(10,2) not null check (total >= 0),
  created_by      uuid not null references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_by      uuid references public.profiles(id),
  updated_at      timestamptz
);

comment on table public.invoices is
  'One invoice per completed appointment, numbered from the shared MRC series. '
  'Written only by save_invoice().';

alter table public.invoices enable row level security;

-- Exactly as visible as its appointment (the appointment_items_select predicate).
create policy invoices_select
  on public.invoices for select
  using (
    exists (
      select 1 from public.appointments a
       where a.id = invoices.appointment_id
         and (a.workspace_id in (select public.my_workspace_ids())
              or a.staff_id = public.my_staff_id())
    )
  );

revoke all on public.invoices from anon;

-- ---------------------------------------------------------------------------
-- save_invoice — create (assigning the next number) or update the invoice of
-- one completed appointment. Items are [{ "description": text, "amount": n }];
-- the total is computed here, never trusted from the caller.
-- ---------------------------------------------------------------------------
create or replace function public.save_invoice(
  p_appointment_id  uuid,
  p_invoice_date    date,
  p_bill_to_name    text,
  p_bill_to_address text,
  p_service_title   text,
  p_items           jsonb,
  p_discount_label  text default null,
  p_discount_amount numeric default 0
)
returns table (invoice_id uuid, invoice_no text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt     public.appointments%rowtype;
  v_items    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_desc     text;
  v_amount   numeric;
  v_subtotal numeric := 0;
  v_discount numeric := round(coalesce(p_discount_amount, 0), 2);
  v_name     text := btrim(coalesce(p_bill_to_name, ''));
  v_existing public.invoices%rowtype;
  v_number   integer;
  v_id       uuid;
  v_ok       boolean;
begin
  if auth.uid() is null or public.my_role() is null then
    raise exception 'Not authorized';
  end if;

  select * into v_appt from public.appointments where id = p_appointment_id;
  -- Each branch coalesced to a definite boolean: for a Master my_staff_id() is
  -- NULL, and a NULL here must mean "no", never "skip the check" (see 0017).
  v_ok := found and (
    coalesce(v_appt.workspace_id in (select public.my_workspace_ids()), false)
    or coalesce(v_appt.staff_id = public.my_staff_id(), false)
  );
  if not v_ok then
    raise exception 'Not authorized';
  end if;

  if v_appt.status <> 'completed' then
    raise exception 'Only a completed appointment can be invoiced';
  end if;

  if p_invoice_date is null or char_length(v_name) < 1 or char_length(v_name) > 200
     or char_length(coalesce(p_bill_to_address, '')) > 500
     or char_length(coalesce(p_service_title, '')) > 200
     or char_length(coalesce(p_discount_label, '')) > 40
     or v_discount < 0
     or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 12 then
    raise exception 'Invoice details are invalid';
  end if;

  -- Rebuild the items from validated parts, so nothing but description and
  -- amount is ever stored, and sum them here.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_desc := btrim(coalesce(v_item->>'description', ''));
    begin
      v_amount := round((v_item->>'amount')::numeric, 2);
    exception when others then
      raise exception 'Invoice details are invalid';
    end;
    if char_length(v_desc) < 1 or char_length(v_desc) > 120 or v_amount is null or v_amount < 0 or v_amount > 100000 then
      raise exception 'Invoice details are invalid';
    end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object('description', v_desc, 'amount', v_amount));
    v_subtotal := v_subtotal + v_amount;
  end loop;

  if v_discount > v_subtotal then
    raise exception 'Invoice details are invalid';
  end if;

  select * into v_existing from public.invoices where appointment_id = v_appt.id for update;

  if found then
    update public.invoices
       set invoice_date    = p_invoice_date,
           bill_to_name    = v_name,
           bill_to_address = nullif(btrim(coalesce(p_bill_to_address, '')), ''),
           service_title   = nullif(btrim(coalesce(p_service_title, '')), ''),
           items           = v_items,
           discount_label  = nullif(btrim(coalesce(p_discount_label, '')), ''),
           discount_amount = v_discount,
           total           = v_subtotal - v_discount,
           updated_by      = auth.uid(),
           updated_at      = now()
     where id = v_existing.id;
    return query select v_existing.id, v_existing.invoice_no;
    return;
  end if;

  -- The next number, under a lock held until this transaction ends.
  select c.next_number into v_number from public.invoice_counter c where c.id for update;
  update public.invoice_counter set next_number = v_number + 1 where id;

  insert into public.invoices (
    appointment_id, invoice_number, invoice_date, bill_to_name, bill_to_address,
    service_title, items, discount_label, discount_amount, total, created_by
  ) values (
    v_appt.id, v_number, p_invoice_date, v_name,
    nullif(btrim(coalesce(p_bill_to_address, '')), ''),
    nullif(btrim(coalesce(p_service_title, '')), ''),
    v_items,
    nullif(btrim(coalesce(p_discount_label, '')), ''),
    v_discount, v_subtotal - v_discount, auth.uid()
  )
  returning id into v_id;

  return query select i.id, i.invoice_no from public.invoices i where i.id = v_id;
end;
$$;

revoke all on function public.save_invoice(uuid, date, text, text, text, jsonb, text, numeric) from public;
revoke all on function public.save_invoice(uuid, date, text, text, text, jsonb, text, numeric) from anon;
grant execute on function public.save_invoice(uuid, date, text, text, text, jsonb, text, numeric) to authenticated;

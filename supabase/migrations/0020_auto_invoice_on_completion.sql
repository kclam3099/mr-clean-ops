-- 0020 — every completed job is an invoice, numbered automatically
--
-- Owner's rule (2026-10-03): "只要是 complete 了的顾客，我们就当是一个 invoice."
-- Marking a job completed now issues its invoice in the same transaction, with
-- the next MRC number, so no completed job is ever without one and the
-- numbering follows completion order.
--
-- THE DEFAULT INVOICE is built from the job itself:
--   date      the job date (as in the owner's sheet: DATE = the job day)
--   bill to   customer name; address line (+ area when not already in it)
--   service   "Deep Cleaning + High Temperature Steam"
--   items     each service line ("SOFA x2" when qty > 1) and each add-on, in
--             whole ringgit; a job with no lines gets one "Cleaning service"
--             line for its total
-- A Master can still change any of it afterwards (save_invoice, 0019).
--
-- ADD-ONS RECORDED AFTER COMPLETION are folded in: while nobody has edited the
-- invoice by hand (updated_at is null), adding or removing an add-on rebuilds
-- its items and total. Once a Master has edited it, it is theirs and is left
-- alone.
--
-- The functions here are internal — fired by triggers, never callable by a
-- user — and run as their owner, so a staff member completing their own job
-- issues the invoice without being able to choose its number or content.

create or replace function public.default_invoice_items(p_appointment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select 1 as src, i.ctid::text as ord,
           btrim(i.description) || case when i.quantity > 1 then ' x' || i.quantity else '' end as description,
           round(coalesce(i.line_total, i.quantity * i.unit_price)) as amount
      from public.appointment_items i
     where i.appointment_id = p_appointment_id
    union all
    select 2, ad.created_at::text, btrim(ad.description), round(ad.amount)
      from public.appointment_addons ad
     where ad.appointment_id = p_appointment_id
  ), picked as (
    select * from lines order by src, ord limit 12
  )
  select case
    when exists (select 1 from picked) then
      (select jsonb_agg(jsonb_build_object('description', left(description, 120), 'amount', amount) order by src, ord) from picked)
    else
      (select jsonb_build_array(jsonb_build_object('description', 'Cleaning service', 'amount', round(a.total_amount)))
         from public.appointments a where a.id = p_appointment_id)
  end
$$;

create or replace function public.auto_issue_invoice(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt    public.appointments%rowtype;
  v_items   jsonb;
  v_total   numeric;
  v_number  integer;
  v_address text;
begin
  if exists (select 1 from public.invoices where appointment_id = p_appointment_id) then
    return;
  end if;
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found or v_appt.status <> 'completed' then
    return;
  end if;

  v_items := public.default_invoice_items(v_appt.id);
  select coalesce(sum((x->>'amount')::numeric), 0) into v_total from jsonb_array_elements(v_items) x;
  v_address := case
    when coalesce(v_appt.area_city, '') = '' or position(lower(v_appt.area_city) in lower(v_appt.address_line)) > 0
      then v_appt.address_line
    else v_appt.address_line || ', ' || v_appt.area_city
  end;

  select c.next_number into v_number from public.invoice_counter c where c.id for update;
  update public.invoice_counter set next_number = v_number + 1 where id;

  insert into public.invoices (
    appointment_id, invoice_number, invoice_date, bill_to_name, bill_to_address,
    service_title, items, discount_label, discount_amount, total, created_by
  ) values (
    v_appt.id, v_number, v_appt.appt_date, left(btrim(v_appt.customer_name), 200), left(v_address, 500),
    'Deep Cleaning + High Temperature Steam', v_items, null, 0, v_total,
    coalesce(auth.uid(), v_appt.created_by)
  );
end;
$$;

-- Rebuild an untouched auto invoice after its add-ons change.
create or replace function public.refresh_auto_invoice(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_total numeric;
begin
  if not exists (
    select 1 from public.invoices
     where appointment_id = p_appointment_id and updated_at is null and discount_amount = 0
  ) then
    return;
  end if;
  v_items := public.default_invoice_items(p_appointment_id);
  select coalesce(sum((x->>'amount')::numeric), 0) into v_total from jsonb_array_elements(v_items) x;
  update public.invoices
     set items = v_items, total = v_total
   where appointment_id = p_appointment_id and updated_at is null;
end;
$$;

create or replace function public.trg_issue_invoice_on_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.auto_issue_invoice(new.id);
  return null;
end;
$$;

drop trigger if exists trg_issue_invoice_on_completion on public.appointments;
create trigger trg_issue_invoice_on_completion
  after update of status on public.appointments
  for each row
  when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function public.trg_issue_invoice_on_completion();

create or replace function public.trg_refresh_invoice_on_addon()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.refresh_auto_invoice(coalesce(new.appointment_id, old.appointment_id));
  return null;
end;
$$;

drop trigger if exists trg_refresh_invoice_on_addon on public.appointment_addons;
create trigger trg_refresh_invoice_on_addon
  after insert or delete on public.appointment_addons
  for each row
  execute function public.trg_refresh_invoice_on_addon();

-- Internal only.
revoke all on function public.default_invoice_items(uuid) from public, anon, authenticated;
revoke all on function public.auto_issue_invoice(uuid) from public, anon, authenticated;
revoke all on function public.refresh_auto_invoice(uuid) from public, anon, authenticated;
revoke all on function public.trg_issue_invoice_on_completion() from public, anon, authenticated;
revoke all on function public.trg_refresh_invoice_on_addon() from public, anon, authenticated;

-- Jobs completed before this rule existed, oldest first.
do $backfill$
declare r record;
begin
  for r in
    select a.id from public.appointments a
     where a.status = 'completed'
       and not exists (select 1 from public.invoices i where i.appointment_id = a.id)
     order by a.appt_date, a.start_time
  loop
    perform public.auto_issue_invoice(r.id);
  end loop;
end
$backfill$;

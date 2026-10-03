-- 0019 — once issued, an invoice is changed or deleted by a Master only
--
-- Owner's rule (2026-10-03): the staff member who did the job may REQUEST the
-- invoice (create it, choosing the details), but after that only a Master —
-- KC, or Nick for Shared Team jobs — may change it or delete it.
--
-- "A Master" means a Master of the appointment's workspace, as everywhere else:
-- Nick cannot touch a KC Private Team invoice any more than he can see it.
--
-- Deleting frees nothing: the number is NOT reused. The next invoice still
-- takes the next number, so the series shows a gap where a deleted invoice
-- was — which is what an auditor expects to see, rather than two different
-- documents that once carried the same number.
--
-- Permission checks are NULL-safe (see 0017): each branch is coalesced to a
-- definite boolean before the IF.

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
  v_appt      public.appointments%rowtype;
  v_items     jsonb := '[]'::jsonb;
  v_item      jsonb;
  v_desc      text;
  v_amount    numeric;
  v_subtotal  numeric := 0;
  v_discount  numeric := round(coalesce(p_discount_amount, 0), 2);
  v_name      text := btrim(coalesce(p_bill_to_name, ''));
  v_existing  public.invoices%rowtype;
  v_number    integer;
  v_id        uuid;
  v_ok        boolean;
  v_is_master boolean;
begin
  if auth.uid() is null or public.my_role() is null then
    raise exception 'Not authorized';
  end if;

  select * into v_appt from public.appointments where id = p_appointment_id;
  v_is_master := found and coalesce(v_appt.workspace_id in (select public.my_workspace_ids()), false);
  v_ok := v_is_master or (found and coalesce(v_appt.staff_id = public.my_staff_id(), false));
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
    -- Issued: from here on, a Master's document.
    if not v_is_master then
      raise exception 'Only a Master can change an issued invoice';
    end if;
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

create or replace function public.delete_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv  public.invoices%rowtype;
  v_ok   boolean;
begin
  if auth.uid() is null or public.my_role() is null then
    raise exception 'Not authorized';
  end if;

  select * into v_inv from public.invoices where id = p_invoice_id for update;
  v_ok := found and coalesce((
    select a.workspace_id in (select public.my_workspace_ids())
      from public.appointments a where a.id = v_inv.appointment_id
  ), false);
  if not v_ok then
    -- Staff, an outsider Master, and a missing id all read the same.
    raise exception 'Not authorized';
  end if;

  delete from public.invoices where id = v_inv.id;
end;
$$;

revoke all on function public.delete_invoice(uuid) from public;
revoke all on function public.delete_invoice(uuid) from anon;
grant execute on function public.delete_invoice(uuid) to authenticated;

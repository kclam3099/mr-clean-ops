import { chromium } from "playwright";
import { adminClient, resolveIdentities, createFixture, CONFIG } from "./supabase/tests/lib/harness.mjs";
const BASE = "http://localhost:3000";
const db = await adminClient(); const ids = await resolveIdentities(db); const fx = createFixture(db);
const browser = await chromium.launch();
const day = async n => (await fx.query(`select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + $1::int),'DD/MM/YY') d`,[n]))[0].d;
const iso = async n => (await fx.query(`select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + $1::int),'YYYY-MM-DD') d`,[n]))[0].d;
try {
  const ctx = await browser.newContext({viewport:{width:1280,height:900}});
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("  PAGEERROR:", e.message.slice(0,200)));
  await page.goto(`${BASE}/login`,{waitUntil:"load"});
  await page.fill("input[name=email]", ids.email.kc);
  await page.fill("input[name=password]", CONFIG.testPassword());
  await page.click("button[type=submit]");
  await page.waitForURL(u=>!u.pathname.startsWith("/login"),{timeout:20000});
  await page.goto(`${BASE}/calendar`,{waitUntil:"load"}); await page.waitForTimeout(1200);

  const d = await day(3);
  const msg = `Appointment Confirmed

Puchong Utama

Name : TEST CUSTOMER Grace
Contact Number: 0148136726
Date: ${d}
Appt Time:  2pm

Address: no 36A Jalan PU 7/3
Bandar Puchong Utama 47100
Puchong Selangor

Remark

Sofa 2 seater L RM179`;

  await page.click('button[aria-label="New appointment"]');
  await page.waitForSelector('[role="dialog"]');
  await page.waitForTimeout(700);
  console.log("step heading:", await page.evaluate(()=>document.querySelector("#quick-add-title")?.textContent));

  // simulate a real paste
  await page.focus("#qa-paste");
  await page.evaluate(async (text) => { await navigator.clipboard.writeText(text); }, msg).catch(()=>{});
  const ok = await page.evaluate(async (text) => {
    const ta = document.querySelector("#qa-paste");
    const dt = new DataTransfer(); dt.setData("text/plain", text);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
    setter.call(ta, text); ta.dispatchEvent(new Event("input",{bubbles:true}));
    ta.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,clipboardData:dt}));
    return true;
  }, msg);
  console.log("paste dispatched:", ok);
  await page.waitForTimeout(1200);

  const review = await page.evaluate(() => ({
    heading: document.querySelector("#quick-add-title")?.textContent,
    card: document.querySelector("[data-review-card]")?.innerText.replace(/\s+/g," ").trim(),
    staff: [...document.querySelectorAll("[data-staff-option]")].map(b=>b.textContent.replace(/Assign$/,"").trim()),
    blocked: !!document.querySelector("[data-confirm-details]"),
  }));
  console.log("REVIEW heading:", review.heading);
  console.log("REVIEW card:", review.card);
  console.log("REVIEW staff:", JSON.stringify(review.staff), "blocked:", review.blocked);

  if (review.staff.length) {
    await page.evaluate(() => [...document.querySelectorAll("[data-staff-option]")].find(b=>b.textContent.includes("TEST_JACK"))?.click());
    await page.waitForTimeout(3500);
    console.log("toast:", await page.evaluate(()=>document.querySelector('[role="status"]')?.textContent ?? null));
    const rows = await fx.query(`select a.customer_name, a.customer_phone, a.address_line, a.area_city, a.appt_date::text d, a.start_time::text t, a.total_amount, s.display_name staff, w.name ws
      from public.appointments a join public.staff s on s.id=a.staff_id join public.workspaces w on w.id=a.workspace_id
      where a.customer_name like 'TEST CUSTOMER Grace%'`);
    console.log("DB:", JSON.stringify(rows,null,1));
    const items = await fx.query(`select description, quantity, unit_price from public.appointment_items where appointment_id in (select id from public.appointments where customer_name like 'TEST CUSTOMER Grace%')`);
    console.log("ITEMS:", JSON.stringify(items));
    console.log("expected date:", await iso(3));
  }
} finally {
  await db.query(`delete from public.appointment_items where appointment_id in (select id from public.appointments where customer_name like 'TEST CUSTOMER Grace%')`);
  await db.query(`delete from public.audit_logs where entity_id in (select id from public.appointments where customer_name like 'TEST CUSTOMER Grace%')`);
  await db.query(`delete from public.appointments where customer_name like 'TEST CUSTOMER Grace%'`);
  await browser.close(); await fx.cleanup(); await db.end();
}

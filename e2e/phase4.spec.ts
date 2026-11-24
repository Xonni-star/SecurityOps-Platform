import { expect, test } from "@playwright/test";

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const apiBase = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:3000";

test.beforeAll(async ({ request }) => {
  if (!email || !password)
    throw new Error(
      "OPEN: E2E_EMAIL and E2E_PASSWORD are required; use isolated fixture credentials, never repository secrets.",
    );
  const ready = await request.get(`${apiBase}/ready`);
  if (!ready.ok())
    throw new Error(
      `OPEN: backend is not ready (${ready.status()}); start isolated services with: docker compose up -d db backend frontend`,
    );
  const response = await request.post(`${apiBase}/api/v1/auth/login`, {
    data: {
      email,
      password,
      device_id: "00000000-0000-4000-8000-000000000201",
      metadata: { platform: "playwright", app_version: "e2e" },
    },
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `OPEN: fixture login failed (${response.status()}): ${body}; run npm run migrate && E2E_FIXTURE=isolated npm run e2e:fixture`,
    );
  }
  const result = await response.json();
  if (result.mfa_pending || result.mfa_required)
    throw new Error(
      "OPEN: fixture unexpectedly requires MFA; provision a current-flow fixture or provide the matching MFA test contract.",
    );
});

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("E-Mail-Adresse").fill(email!);
  await page.getByLabel("Passwort").fill(password!);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function csrfHeaders(page: import("@playwright/test").Page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find(
    (cookie) => cookie.name === "securityops_csrf",
  )?.value;
  if (!csrf)
    throw new Error(
      "OPEN: authenticated browser session did not receive a CSRF cookie",
    );
  return { "x-csrf-token": decodeURIComponent(csrf) };
}

test("real browser login, role/tenant access and NSL dashboard", async ({
  page,
}) => {
  await login(page);
  await expect(
    page.getByRole("heading", { name: "NSL-Leitstelle" }),
  ).toBeVisible();
  const me = await page.request.get("/api/v1/auth/me");
  expect(me.ok()).toBeTruthy();
  const { user } = await me.json();
  expect(user.role).toBe("operator");
  expect(user.permissions).toContain("nsl:read");
  expect(user.permissions).toContain("alarms:write");
  const dashboard = await page.request.get("/api/v1/nsl/dashboard");
  expect(dashboard.ok()).toBeTruthy();
  expect((await dashboard.json()).alarms).toBeInstanceOf(Array);
});

test("creates, acknowledges and resolves an alarm through the UI", async ({
  page,
}) => {
  await login(page);
  const priorities = await (
    await page.request.get("/api/v1/alarm-priorities")
  ).json();
  const priority = priorities.find(
    (item: { code: string }) => item.code === "high",
  );
  expect(priority).toBeTruthy();
  const created = await page.request.post("/api/v1/alarms", {
    headers: await csrfHeaders(page),
    data: {
      priority_id: priority.id,
      source: "playwright",
      description: `E2E Alarm ${Date.now()}`,
    },
  });
  expect(created.status()).toBe(201);
  const description = (await created.json()).description;
  await page.goto("/alarms");
  await expect(page.getByText(description)).toBeVisible();
  const row = page.locator("tr").filter({ hasText: description });
  await row.getByRole("button", { name: "Quittieren" }).click();
  await expect(row.getByText("acknowledged")).toBeVisible();
  await row.getByRole("button", { name: "Erledigen" }).click();
  await expect(row.getByText("resolved")).toBeVisible();
});

test("runs the mobile PWA offline outbox and reconciles the server receipt", async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto("/mobile");
  const sw = await page.evaluate(async () =>
    Boolean((await navigator.serviceWorker.ready).active),
  );
  expect(sw).toBeTruthy();
  await expect(page.getByText(/Online/)).toBeVisible();
  await page.getByLabel("Route").fill("00000000-0000-4000-8000-000000000106");
  await page
    .getByLabel("Mitarbeiter-ID")
    .fill("00000000-0000-4000-8000-000000000104");
  await page.getByLabel("NFC-/Barcode-Kennung").fill("e2e-nfc-01");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Kontrollpunkt bestätigen" }).click();
  await expect(
    page.getByText("Offline gespeichert; wird nach Verbindung synchronisiert."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Offline-Outbox \(1\)/ }),
  ).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Jetzt synchronisieren" }).click();
  await expect(page.getByText(/synchronisiert/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Offline-Outbox \(0\)/ }),
  ).toBeVisible();
});

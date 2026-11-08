import { test, expect, type Page, type Locator } from "@playwright/test";

async function touchOrClick(locator: Locator) {
  if (test.info().project.name === "android") await locator.tap();
  else await locator.click();
}

async function addText(
  page: Page,
  {
    title = "Проверка немецкого",
    text = "Er beschloss zu gehen.\n\nEr steht früh auf.",
    lang = "de",
  } = {},
) {
  await page.goto("/library");
  await page.getByRole("button", { name: "Добавить текст" }).click();
  const form = page.getByRole("dialog", { name: "Новый текст" });
  await form.getByLabel("Название", { exact: true }).fill(title);
  await form
    .getByRole("combobox", { name: "Язык", exact: true })
    .selectOption(lang);
  await form.getByLabel("Текст", { exact: true }).fill(text);
  await form.getByRole("button", { name: "Сохранить текст" }).click();
  await expect(form).not.toBeVisible();
  await page
    .getByRole("link", { name: "Читать " + title, exact: true })
    .click();
  await expect(page.getByTestId("reader-text")).toHaveText(text);
}
async function selectText(page: Page, start: number, end: number) {
  await page.getByTestId("reader-text").evaluate(
    (el, { start, end }) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      let count = 0;
      let first: Node | null = null,
        last: Node | null = null,
        firstOffset = 0,
        lastOffset = 0;
      while ((node = walk.nextNode())) {
        const length = node.textContent?.length || 0;
        if (!first && count + length > start) {
          first = node;
          firstOffset = start - count;
        }
        if (first && count + length >= end) {
          last = node;
          lastOffset = end - count;
          break;
        }
        count += length;
      }
      if (!first || !last) throw Error("Selection target missing");
      const range = document.createRange();
      range.setStart(first, firstOffset);
      range.setEnd(last, lastOffset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { start, end },
  );
}

test("add, analyze, cache, save, reopen and delete a vocabulary entry", async ({
  page,
}) => {
  let paidRequests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/analyze")) paidRequests++;
  });
  await addText(page);
  const reader = page.getByTestId("reader-text");
  await touchOrClick(
    reader.getByRole("button", { name: "beschloss", exact: true }),
  );
  const dialog = page.getByRole("dialog", { name: "Анализ слова" });
  await expect(
    dialog.getByRole("heading", { name: "beschloss", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("решил", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("ТЕСТОВЫЙ РЕЗУЛЬТАТ");
  await expect(dialog).toContainText("Präteritum");
  await dialog.getByRole("button", { name: "Подробно" }).click();
  await expect(dialog).toContainText("тестовая карточка");
  await dialog.getByRole("button", { name: "Добавить в словарь" }).click();
  await expect(
    dialog.getByRole("button", { name: "Уже в словаре" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть анализ" }).click();
  await touchOrClick(
    reader.getByRole("button", { name: "beschloss", exact: true }),
  );
  await expect(dialog.getByText("решил", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть анализ" }).click();
  await page.getByRole("link", { name: /Словарь/ }).click();
  await expect(page.locator(".vocab-row")).toHaveCount(1);
  await page.getByLabel("Поиск слов").fill("beschließen");
  await expect(page.locator(".vocab-row")).toHaveCount(1);
  await page.getByRole("button", { name: /beschloss.*beschließen/ }).click();
  await expect(dialog.getByText("решил", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть анализ" }).click();
  await page
    .getByRole("button", { name: "Удалить слово beschloss", exact: true })
    .click();
  await expect(page.locator(".vocab-row")).toHaveCount(0);
  expect(paidRequests).toBe(0); // Demo is explicitly local and never masquerades as a paid AI response.
});

test("multiword selection uses original expression and preserves paragraphs", async ({
  page,
}) => {
  const text = "She gave up smoking.\n\nA new beginning!";
  await addText(page, { title: "An English story", text, lang: "en" });
  const reader = page.getByTestId("reader-text");
  await expect(reader).toHaveText(text);
  expect(await reader.textContent()).toBe(text);
  await selectText(
    page,
    text.indexOf("gave"),
    text.indexOf("gave") + "gave up".length,
  );
  await page
    .getByRole("button", { name: "Проанализировать выражение" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Анализ слова" });
  await expect(
    dialog.getByRole("heading", { name: "gave up", exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("give up");
  await expect(dialog).toContainText("фразовый глагол");
});

test("cached words work offline while new analyses report missing connection", async ({
  page,
  context,
}) => {
  await addText(page);
  const reader = page.getByTestId("reader-text");
  await touchOrClick(
    reader.getByRole("button", { name: "beschloss", exact: true }),
  );
  const dialog = page.getByRole("dialog", { name: "Анализ слова" });
  await expect(dialog.getByText("решил", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть анализ" }).click();
  await context.setOffline(true);
  await touchOrClick(
    reader.getByRole("button", { name: "beschloss", exact: true }),
  );
  await expect(dialog.getByText("решил", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть анализ" }).click();
  await touchOrClick(
    reader.getByRole("button", { name: "steht", exact: true }),
  );
  await expect(page.getByRole("status")).toContainText("Нет подключения");
  await context.setOffline(false);
});

test("keyboard analysis, preferences, routes and responsive width", async ({
  page,
}) => {
  await addText(page);
  const word = page
    .getByTestId("reader-text")
    .getByRole("button", { name: "beschloss", exact: true });
  await word.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Анализ слова" }),
  ).toContainText("решил");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Анализ слова" }),
  ).not.toBeVisible();
  await page
    .getByRole("link", { name: /Настройки/, exact: false })
    .filter({ hasText: "Настройки" })
    .first()
    .click();
  await page.getByLabel("Тема", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  for (const path of ["/library", "/read", "/vocabulary", "/settings"]) {
    await page.goto(path);
    await expect(
      page.getByRole("navigation").getByRole("link").first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test("installed service worker reopens the saved reader after an offline reload", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.PLAYWRIGHT_PRODUCTION !== "1",
    "Service-worker readiness is validated against a production build.",
  );
  const text =
    "Ein offline gespeicherter Text.\n\nEr bleibt auch ohne Internet lesbar.";
  await addText(page, { title: "Офлайн-чтение", text });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  // A controlled online reload lets the worker retain the current build's chunks.
  await page.reload();
  await expect(page.getByTestId("reader-text")).toHaveText(text);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("reader-text")).toHaveText(text);
  expect(await page.getByTestId("reader-text").textContent()).toBe(text);
  await expect(
    page.getByText(
      "Нет подключения. Доступны загруженные тексты и сохранённые карточки.",
    ),
  ).toBeVisible();
  await context.setOffline(false);
});

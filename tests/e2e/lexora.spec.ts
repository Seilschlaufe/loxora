import { test, expect, type Page, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";

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
  const compact = dialog.getByTestId("compact-analysis");
  await expect(compact).not.toContainText("глагол");
  await expect(compact).not.toContainText("Ещё один пример");
  await expect(dialog.getByTestId("expanded-analysis")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Подробнее о значении" }).click();
  await expect(dialog.getByTestId("expanded-analysis")).toContainText("Демо:");
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
  // An expanded reader response must never become part of a vocabulary card.
  await expect(dialog.getByTestId("expanded-analysis")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Подробнее о значении" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть анализ" }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON", exact: false }).click();
  const download = await downloadEvent;
  const file = await download.path();
  expect(file).toBeTruthy();
  const exported = JSON.parse(await readFile(file!, "utf8"));
  expect(exported).toHaveLength(1);
  expect(exported[0].analysis.original_word).toBe("beschloss");
  expect(exported[0].analysis.contextual_translation_ru).toBe("решил");
  for (const key of [
    "meaning_ru",
    "contextual_nuance_ru",
    "distinctions_ru",
    "alternative_meanings_ru",
    "expanded",
    "contextual_explanation_ru",
    "example_original",
    "part_of_speech",
  ]) {
    expect(JSON.stringify(exported)).not.toContain('"' + key + '"');
  }
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
  await expect(dialog).toContainText("Past Simple");
  await expect(dialog.getByTestId("compact-analysis")).not.toContainText(
    "фразовый глагол",
  );
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

test("reader popup stays below word and closes only when the text scrolls", async ({
  page,
}) => {
  await addText(page, {
    text:
      "Er beschloss zu gehen.\n\n" +
      "Ein langer Absatz mit vielen Wörtern.\n\n".repeat(100),
  });
  const word = page
    .getByTestId("reader-text")
    .getByRole("button", { name: "beschloss", exact: true });
  await touchOrClick(word);
  const dialog = page.getByRole("dialog", { name: "Анализ слова" });
  await expect(dialog.getByText("решил", { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const w = await word.boundingBox(),
        d = await dialog.boundingBox();
      return w && d ? Math.round(d.y - (w.y + w.height)) : -1;
    })
    .toBe(8);
  await dialog.getByRole("button", { name: "Подробнее о значении" }).click();
  await expect(dialog.getByTestId("expanded-analysis")).toContainText("Демо:");
  await dialog.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.scrollBy(0, 150));
  await expect(dialog).not.toBeVisible();
  await page.waitForTimeout(300);
  await expect(dialog).not.toBeVisible();
});

test("both a separated verb and its particle open the complete construction", async ({
  page,
}) => {
  await addText(page, { text: "Er steht jeden Morgen früh auf." });
  const reader = page.getByTestId("reader-text");
  const dialog = page.getByRole("dialog", { name: "Анализ слова" });
  for (const clicked of ["steht", "auf"]) {
    await touchOrClick(
      reader.getByRole("button", { name: clicked, exact: true }),
    );
    await expect(
      dialog.getByRole("heading", { name: clicked, exact: true }),
    ).toBeVisible();
    await expect(dialog.getByTestId("compact-analysis")).toContainText(
      "aufstehen",
    );
    await expect(dialog.getByTestId("compact-analysis")).toContainText(
      "встаёт",
    );
    await expect(dialog.getByTestId("compact-analysis")).toContainText(
      "Singular",
    );
    await expect(dialog.getByTestId("expanded-analysis")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Закрыть анализ" }).click();
  }
});

test("an unavailable expansion leaves the compact translation usable offline", async ({
  page,
  context,
}) => {
  await addText(page);
  const reader = page.getByTestId("reader-text");
  await touchOrClick(
    reader.getByRole("button", { name: "beschloss", exact: true }),
  );
  const dialog = page.getByRole("dialog", { name: "Анализ слова" });
  await expect(dialog.getByTestId("compact-analysis")).toContainText("решил");
  await context.setOffline(true);
  await dialog.getByRole("button", { name: "Подробнее о значении" }).click();
  await expect(dialog).toContainText(/подключени|интернет/i);
  await expect(dialog.getByTestId("compact-analysis")).toContainText("решил");
  await expect(dialog.locator(".expanded-analysis-points")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Добавить в словарь" }).click();
  await expect(
    dialog.getByRole("button", { name: "Уже в словаре" }),
  ).toBeVisible();
  await context.setOffline(false);
});

test("a cached expansion still requires a click and can reopen offline", async ({
  page,
  context,
}) => {
  await addText(page);
  const word = page
    .getByTestId("reader-text")
    .getByRole("button", { name: "beschloss", exact: true });
  await touchOrClick(word);
  const dialog = page.getByRole("dialog", { name: "Анализ слова" });
  await dialog.getByRole("button", { name: "Подробнее о значении" }).click();
  const expanded = dialog.getByTestId("expanded-analysis");
  await expect(expanded).toContainText("Демо:");
  const content = await expanded.textContent();
  await dialog.getByRole("button", { name: "Закрыть анализ" }).click();
  await context.setOffline(true);
  await touchOrClick(word);
  await expect(dialog.getByTestId("expanded-analysis")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Подробнее о значении" }).click();
  await expect(expanded).toHaveText(content!);
  await context.setOffline(false);
});

test("legacy full vocabulary records display and export only compact data", async ({
  page,
}) => {
  await page.goto("/library");
  await expect(
    page.getByRole("heading", { name: /Каждый текст/ }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("lexora", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      const store = tx.objectStore("state");
      const req = store.get("demo:snapshot");
      req.onsuccess = () => {
        const snapshot = req.result;
        store.put(
          {
            ...snapshot,
            entries: [
              {
                id: "legacy-word",
                document_id: snapshot.docs[0].id,
                created_at: new Date().toISOString(),
                demo: true,
                analysis: {
                  original_word: "beschloss",
                  lemma: "beschließen",
                  language: "de",
                  contextual_translation_ru: "решил",
                  original_sentence: "Er beschloss zu gehen.",
                  part_of_speech: "глагол",
                  morphology: {
                    tense: null,
                    mood: null,
                    person: null,
                    number: null,
                    gender: null,
                    case: null,
                    other: "Präteritum, единственное число",
                  },
                  grammar_explanation_ru: "Präteritum, единственное число",
                  contextual_explanation_ru: "UNSAVED_EXPANSION_LEGACY",
                  sentence_translation_ru: "UNSAVED_EXPANSION_LEGACY",
                  alternative_meanings_ru: ["UNSAVED_EXPANSION_LEGACY"],
                  example_original: "UNSAVED_EXPANSION_LEGACY",
                  example_translation_ru: "UNSAVED_EXPANSION_LEGACY",
                  expression_notes_ru: null,
                  ambiguity_notes_ru: null,
                },
              },
            ],
          },
          "demo:snapshot",
        );
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto("/vocabulary");
  await expect(page.locator(".vocab-row")).toHaveCount(1);
  await page.getByRole("button", { name: /beschloss.*beschließen/ }).click();
  const dialog = page.getByRole("dialog", { name: "Анализ слова" });
  await expect(dialog.getByTestId("compact-analysis")).toContainText(
    "Präteritum",
  );
  await expect(dialog.getByTestId("compact-analysis")).toContainText(
    "Singular",
  );
  await expect(dialog).not.toContainText("UNSAVED_EXPANSION_LEGACY");
  await expect(dialog.getByTestId("expanded-analysis")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Закрыть анализ" }).click();
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON", exact: false }).click();
  const download = await event;
  const text = await readFile((await download.path())!, "utf8");
  expect(text).not.toContain("UNSAVED_EXPANSION_LEGACY");
  expect(text).not.toContain("part_of_speech");
  expect(JSON.parse(text)[0].analysis.original_word).toBe("beschloss");
});

/** Optional paid model-quality checks. Never run just because a developer has a key.
 * LEXORA_LIVE_AI_TESTS=1 OPENAI_API_KEY=... npm test -- tests/live-ai.test.ts
 * Uses the production schema and prompt, but does not exercise Supabase/Auth. */
import { describe, it, expect } from "vitest";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  analysisSchema,
  ANALYSIS_INSTRUCTIONS,
  type Analysis,
} from "../lib/analysis";
const enabled =
  process.env.LEXORA_LIVE_AI_TESTS === "1" && !!process.env.OPENAI_API_KEY;
async function analyze(
  language: "de" | "en" | "es",
  selected: string,
  sentence: string,
): Promise<Analysis> {
  const ai = new OpenAI({ timeout: 45000, maxRetries: 1 });
  const response = await ai.responses.parse({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [
      { role: "system", content: ANALYSIS_INSTRUCTIONS },
      {
        role: "user",
        content: JSON.stringify({ language, selected, sentence }),
      },
    ],
    text: { format: zodTextFormat(analysisSchema, "word_analysis") },
  });
  const a = analysisSchema.parse(response.output_parsed);
  expect(a.language).toBe(language);
  expect(a.original_word).toBe(selected);
  expect(a.original_sentence).toBe(sentence);
  expect(a.contextual_translation_ru).toMatch(/[а-яё]/i);
  expect(a.grammar_explanation_ru.length).toBeGreaterThan(15);
  expect(a.contextual_explanation_ru).toMatch(/[а-яё]/i);
  expect(a.sentence_translation_ru).toMatch(/[а-яё]/i);
  return a;
}
const grammar = (a: Analysis) =>
  JSON.stringify([
    a.morphology,
    a.grammar_explanation_ru,
    a.expression_notes_ru,
  ]);
describe.skipIf(!enabled)("live model quality (explicit opt-in, paid)", () => {
  it("resolves beschloss to beschließen and past morphology", async () => {
    const a = await analyze(
      "de",
      "beschloss",
      "Anna beschloss, eine Reise zu machen.",
    );
    expect(a.lemma.toLowerCase()).toContain("beschließen");
    expect(grammar(a)).toMatch(/Präteritum|прошедш/i);
  }, 60000);
  it("recognizes a separated German prefix in context", async () => {
    const a = await analyze(
      "de",
      "steht",
      "Er steht jeden Morgen um sieben Uhr auf.",
    );
    expect(
      [a.lemma, a.contextual_explanation_ru, a.expression_notes_ru].join(" "),
    ).toMatch(/aufstehen/i);
    expect(grammar(a)).toMatch(/отделяем|приставк/i);
  }, 60000);
  it("recognizes an English phrasal verb", async () => {
    const a = await analyze(
      "en",
      "gave up",
      "After ten years, she finally gave up smoking.",
    );
    expect(a.lemma.toLowerCase()).toContain("give up");
    expect(grammar(a)).toMatch(/фразов|phrasal/i);
    expect(a.contextual_translation_ru).toMatch(/брос|отказ|прекрат/i);
  }, 60000);
  it("recognizes a Spanish compound past form", async () => {
    const a = await analyze(
      "es",
      "habíamos hablado",
      "Cuando llegó Ana, ya habíamos hablado del problema.",
    );
    expect(a.lemma.toLowerCase()).toContain("hablar");
    expect(grammar(a)).toMatch(/pluscuamperfecto|предпрошедш/i);
    expect(grammar(a)).toMatch(/множествен|plural|1.*лиц|перв.*лиц/i);
  }, 60000);
  it("distinguishes two contextual senses of bank", async () => {
    const river = await analyze(
      "en",
      "bank",
      "They sat on the grassy bank of the river.",
    );
    const money = await analyze(
      "en",
      "bank",
      "She deposited her salary at the bank.",
    );
    expect(river.contextual_translation_ru).toMatch(/берег/i);
    expect(money.contextual_translation_ru).toMatch(/банк/i);
    expect(river.contextual_translation_ru).not.toBe(
      money.contextual_translation_ru,
    );
  }, 120000);
});

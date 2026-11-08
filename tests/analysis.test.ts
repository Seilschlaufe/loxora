import { describe, it, expect } from "vitest";
import {
  analysisSchema,
  context,
  demoAnalysis,
  segments,
} from "../lib/analysis";

describe("exact text segmentation", () => {
  it.each([
    ["de", "  Er beschloss, zu gehen.\n\n„Steht er auf?“ — Ja!\tGroß."],
    [
      "en",
      "She gave up.\nBut don't change  two spaces, emojis 👩🏽‍💻 or punctuation!",
    ],
    ["es", "¿Habíamos hablado?\r\nNiño, España… ¡Sí!"],
  ])("preserves every UTF-16 offset and character (%s)", (lang, text) => {
    const tokens = segments(text, lang);
    expect(tokens.map((t) => t.text).join("")).toBe(text);
    for (const token of tokens)
      expect(text.slice(token.start, token.end)).toBe(token.text);
    expect(tokens.filter((t) => t.word).length).toBeGreaterThan(2);
    expect(tokens.at(-1)?.end).toBe(text.length);
  });
  it("never converts punctuation or whitespace into clickable words", () => {
    const tokens = segments("  Hallo, Welt!\n", "de");
    expect(tokens.filter((t) => t.word).map((t) => t.text)).toEqual([
      "Hallo",
      "Welt",
    ]);
  });
});

describe("context boundaries", () => {
  it("uses the selected sentence, not the whole document", () => {
    const text = "First sentence. She gave up. Last sentence.";
    const start = text.indexOf("gave");
    expect(context(text, start, start + 7, "en").trim()).toBe("She gave up.");
  });
  it("retains a separable German verb in the same context", () => {
    const text = "Er steht jeden Morgen früh auf. Dann liest er.";
    const start = text.indexOf("steht");
    expect(context(text, start, start + 5, "de")).toContain("auf.");
    expect(context(text, start, start + 5, "de")).not.toContain("liest");
  });
  it("distinguishes the same word in different contexts", () => {
    const a = "She sat on the bank.";
    const b = "She paid at the bank.";
    expect(context(a, a.indexOf("bank"), a.indexOf("bank") + 4, "en")).not.toBe(
      context(b, b.indexOf("bank"), b.indexOf("bank") + 4, "en"),
    );
  });
  it("retains the selected word near the end of a long sentence", () => {
    const text =
      "sehr ".repeat(1500) + "beschloss " + "weiter ".repeat(1000) + ".";
    const start = text.indexOf("beschloss");
    const result = context(text, start, start + 9, "de");
    expect(result.length).toBeLessThanOrEqual(1800);
    expect(result).toContain("beschloss");
  });
  it("bounds the context transmitted to the model", () => {
    const text = "lang ".repeat(2000) + ".";
    expect(context(text, 0, 4, "de").length).toBeLessThanOrEqual(1800);
  });
});

describe("structured analysis contract and explicit fixtures", () => {
  it.each([
    ["de", "beschloss", "Er beschloss zu gehen.", "beschließen", "Präteritum"],
    ["de", "steht", "Er steht früh auf.", "aufstehen", "отделяемый"],
    ["en", "gave up", "She gave up smoking.", "give up", "фразовый"],
    [
      "es",
      "habíamos hablado",
      "Ya habíamos hablado antes.",
      "hablar",
      "Pluscuamperfecto",
    ],
  ] as const)(
    "provides a valid, clearly labeled fixture for %s / %s",
    (lang, word, sentence, lemma, grammar) => {
      const result = analysisSchema.parse(demoAnalysis(word, sentence, lang));
      expect(result.original_word).toBe(word);
      expect(result.original_sentence).toBe(sentence);
      expect(result.lemma).toBe(lemma);
      expect(result.grammar_explanation_ru).toContain(grammar);
      expect(result.contextual_explanation_ru).toContain("тестовая");
      expect(result.ambiguity_notes_ru).toContain("Деморежим");
    },
  );
  it("accepts null for inapplicable grammar and rejects malformed or incomplete output", () => {
    const result = demoAnalysis("word", "A word.", "en");
    expect(result.morphology.case).toBeNull();
    expect(
      analysisSchema.safeParse({ ...result, morphology: null }).success,
    ).toBe(false);
    expect(
      analysisSchema.safeParse({ ...result, language: "ru" }).success,
    ).toBe(false);
    expect(
      analysisSchema.safeParse({
        ...result,
        alternative_meanings_ru: ["a", "b", "c", "d"],
      }).success,
    ).toBe(false);
    expect(analysisSchema.safeParse({ lemma: "word" }).success).toBe(false);
  });
});

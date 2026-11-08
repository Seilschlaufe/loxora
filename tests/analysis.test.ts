import { describe, it, expect } from "vitest";
import {
  analysisSchema,
  context,
  demoAnalysis,
  segments,
  expandedSchema,
  demoExpanded,
  toCompact,
  resolveAnalysis,
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
    ["de", "steht", "Er steht früh auf.", "aufstehen", "Präsens"],
    ["en", "gave up", "She gave up smoking.", "give up", "Past Simple"],
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
      expect(JSON.stringify(result.morphology)).toContain(grammar);
      expect(result.usage_note_ru).toBeNull();
      expect(expandedSchema.parse(demoExpanded(result)).meaning_ru).toContain(
        "Демо",
      );
      expect(result).not.toHaveProperty("part_of_speech");
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
      expandedSchema.safeParse({
        ...demoExpanded(result),
        alternative_meanings_ru: ["a", "b", "c", "d"],
      }).success,
    ).toBe(false);
    expect(analysisSchema.safeParse({ lemma: "word" }).success).toBe(false);
  });
});

describe("compact source and legacy conversion", () => {
  it("strips every expanded/legacy explanation from existing saved rows", () => {
    const a = demoAnalysis("beschloss", "Er beschloss zu gehen.", "de");
    const legacy = {
      ...a,
      morphology: { ...a.morphology, other: "Длинное старое объяснение" },
      grammar_explanation_ru: "Präteritum, единственное число",
      part_of_speech: "глагол",
      contextual_explanation_ru: "EXTENDED",
      example_original: "EXAMPLE",
      alternative_meanings_ru: ["OTHER"],
    };
    delete (legacy as Partial<typeof legacy>).dictionary_translation_ru;
    delete (legacy as Partial<typeof legacy>).construction;
    delete (legacy as Partial<typeof legacy>).usage_note_ru;
    delete (legacy as Partial<typeof legacy>).ambiguity_note_ru;
    const result = toCompact(legacy);
    expect(result.morphology.other).toBeNull();
    expect(result.morphology.tense).toBe("Präteritum");
    expect(JSON.stringify(result)).not.toMatch(
      /EXTENDED|EXAMPLE|OTHER|part_of_speech|Длинное/,
    );
  });
  it.each(["steht", "auf"])(
    "links a separated prefix when selecting %s",
    (word) => {
      const text = "Vorher. Er steht heute sehr früh auf.";
      const sentence = "Er steht heute sehr früh auf.";
      const start = text.indexOf(word);
      const fixture = demoAnalysis(word, sentence, "de");
      const raw = {
        ...fixture,
        construction: { ...fixture.construction!, parts: ["steht", "auf"] },
      };
      const result = resolveAnalysis(raw, {
        text,
        sentence,
        selected: word,
        start,
        language: "de",
      });
      expect(result.lemma).toBe("aufstehen");
      expect(
        result.construction?.parts.map((p) => text.slice(p.start, p.end)),
      ).toEqual(["steht", "auf"]);
      expect(result.construction?.parts[0].start).toBe(text.indexOf("steht"));
    },
  );
  it("does not turn an independent preposition into an unrelated construction", () => {
    const result = demoAnalysis("auf", "Das Buch liegt auf dem Tisch.", "de");
    expect(result.construction).toBeNull();
  });
  it("rejects invented components and a construction not containing the selection", () => {
    const text = "Er steht früh auf.";
    const fixture = demoAnalysis("steht", text, "de");
    const source = {
      text,
      sentence: text,
      selected: "steht",
      start: text.indexOf("steht"),
      language: "de" as const,
    };
    expect(() =>
      resolveAnalysis(
        {
          ...fixture,
          construction: { ...fixture.construction, parts: ["steht", "weg"] },
        },
        source,
      ),
    ).toThrow();
  });
  it("does not duplicate an identical dictionary translation", () => {
    const text = "Er beschloss zu gehen.";
    const a = demoAnalysis("beschloss", text, "de");
    const result = resolveAnalysis(
      { ...a, dictionary_translation_ru: "  РЕШИЛ " },
      { text, sentence: text, selected: "beschloss", start: 3, language: "de" },
    );
    expect(result.dictionary_translation_ru).toBeNull();
  });
});

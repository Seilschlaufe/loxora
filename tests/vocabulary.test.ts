import { it, expect } from "vitest";
import { demoAnalysis, demoExpanded } from "../lib/analysis";
import {
  compactEntry,
  compactEntries,
  vocabularyExport,
} from "../lib/vocabulary";
const analysis = demoAnalysis("beschloss", "Er beschloss zu gehen.", "de");
const metadata = {
  id: "entry-a",
  document_id: "doc-a",
  created_at: "2026-01-01T00:00:00Z",
  demo: true,
};
it("save payload and both exports exclude expanded results even if accidentally attached", () => {
  const expanded = demoExpanded(analysis);
  const mixed = {
    ...metadata,
    expanded,
    analysis: {
      ...analysis,
      ...expanded,
      part_of_speech: "глагол",
      example_original: "expanded example",
    },
  };
  const saved = compactEntry(mixed);
  expect(saved).toEqual({ ...metadata, analysis });
  const json = vocabularyExport([mixed], "json");
  const csv = vocabularyExport([mixed], "csv");
  expect(JSON.parse(json)).toEqual([{ ...metadata, analysis }]);
  for (const key of [
    "meaning_ru",
    "contextual_nuance_ru",
    "distinctions_ru",
    "alternative_meanings_ru",
    "part_of_speech",
    "example_original",
    "expanded",
  ])
    expect(json).not.toContain('"' + key + '"');
  expect(csv).not.toContain(expanded.meaning_ru);
  expect(csv).not.toContain("expanded example");
  expect(csv).toContain("Präteritum");
});
it("converts old saved full cards into a compact display/export without losing the word", () => {
  const {
    dictionary_translation_ru,
    construction,
    usage_note_ru,
    ambiguity_note_ru,
    ...base
  } = analysis;
  const legacy = {
    ...metadata,
    analysis: {
      ...base,
      part_of_speech: "глагол",
      grammar_explanation_ru: "Präteritum, единственное число",
      contextual_explanation_ru: "old expanded explanation",
      example_original: "old example",
      alternative_meanings_ru: ["old alternative"],
    },
  };
  const result = compactEntries([legacy]);
  expect(result).toHaveLength(1);
  expect(result[0].analysis.original_word).toBe("beschloss");
  expect(result[0].analysis.morphology.tense).toBe("Präteritum");
  const json = vocabularyExport([legacy], "json");
  expect(json).not.toContain("old expanded explanation");
  expect(json).not.toContain("old example");
});
it("escapes spreadsheet formulas and quoted multiline source text in CSV", () => {
  const csv = vocabularyExport(
    [
      {
        ...metadata,
        analysis: {
          ...analysis,
          original_word: "=1+1",
          original_sentence: 'A "quote"\nnew line',
        },
      },
    ],
    "csv",
  );
  expect(csv).toContain('"\'=1+1"');
  expect(csv).toContain('"A ""quote""\nnew line"');
});

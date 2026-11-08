import { z } from "zod";
import { toCompact, type Entry } from "./analysis";
const entryMetadata = z.object({
  id: z.string(),
  document_id: z.string().nullable(),
  created_at: z.string(),
  demo: z.boolean(),
  analysis: z.unknown(),
});
/** Drop every field outside the compact contract, including old full analyses. */
export function compactEntry(value: unknown): Entry {
  const entry = entryMetadata.parse(value);
  return { ...entry, analysis: toCompact(entry.analysis) };
}
export function compactEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    try {
      return [compactEntry(entry)];
    } catch {
      return [];
    }
  });
}
export function vocabularyExport(entries: unknown, format: "json" | "csv") {
  const clean = compactEntries(entries);
  if (format === "json") return JSON.stringify(clean, null, 2);
  const safe = (value: string) =>
    /^[\s]*[=+\-@\t\r]/.test(value) ? "'" + value : value;
  const rows = [
    [
      "Слово",
      "Лемма",
      "Язык",
      "В контексте",
      "Словарный перевод",
      "Конструкция",
      "Грамматика",
      "Примечание",
      "Исходное предложение",
      "Документ",
      "Дата",
    ],
    ...clean.map((e) => [
      e.analysis.original_word,
      e.analysis.lemma,
      e.analysis.language,
      e.analysis.contextual_translation_ru,
      e.analysis.dictionary_translation_ru || "",
      e.analysis.construction?.text || "",
      Object.values(e.analysis.morphology).filter(Boolean).join(" · "),
      e.analysis.usage_note_ru || "",
      e.analysis.original_sentence,
      e.document_id || "",
      e.created_at,
    ]),
  ];
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row.map((v) => '"' + safe(v).replaceAll('"', '""') + '"').join(","),
      )
      .join("\r\n")
  );
}

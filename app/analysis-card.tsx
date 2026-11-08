"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { Analysis, ExpandedAnalysis } from "@/lib/analysis";
import "./analysis-card.css";

export type AnalysisCardProps = {
  analysis: Analysis | null;
  demo: boolean;
  loading: boolean;
  expanded: ExpandedAnalysis | null;
  expandedLoading: boolean;
  expandedError: string | null;
  onExpand: () => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  onClose: () => void;
  anchored: boolean;
  anchor: { x: number; y: number };
};

function normalized(value: string) {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

function unique(values: (string | null | undefined)[]) {
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    if (!value?.trim()) return false;
    const key = normalized(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The compact record is the only analysis that can be saved by the caller. */
export default function AnalysisCard({
  analysis,
  demo,
  loading,
  expanded,
  expandedLoading,
  expandedError,
  onExpand,
  onSave,
  saving,
  saved,
  onClose,
  anchored,
  anchor,
}: AnalysisCardProps) {
  const [showExpanded, setShowExpanded] = useState(false);
  useEffect(() => {
    setShowExpanded(false);
  }, [analysis?.original_word, analysis?.original_sentence]);

  const dictionary = analysis?.dictionary_translation_ru?.trim();
  const showDictionary =
    !!dictionary &&
    normalized(dictionary) !==
      normalized(analysis?.contextual_translation_ru || "");
  const showLemma =
    !!analysis?.lemma &&
    !showDictionary &&
    normalized(analysis.lemma) !== normalized(analysis.original_word);
  const grammar = analysis ? unique(Object.values(analysis.morphology)) : [];
  const expandedPoints = expanded
    ? unique([
        expanded.meaning_ru,
        expanded.contextual_nuance_ru,
        ...expanded.distinctions_ru,
        ...expanded.alternative_meanings_ru,
        expanded.usage_note_ru,
      ])
    : [];
  const top = anchored ? anchor.y : Math.max(90, anchor.y);

  function openExpanded() {
    if (showExpanded) {
      setShowExpanded(false);
      return;
    }
    setShowExpanded(true);
    if (!expanded && !expandedLoading) onExpand();
  }

  return (
    <section
      className={
        "analysis-card concise-analysis-card" +
        (anchored ? " word-popover" : "")
      }
      role="dialog"
      aria-label="Анализ слова"
      style={
        {
          left: anchored ? anchor.x : Math.max(12, anchor.x),
          top,
          "--card-top": top + "px",
        } as CSSProperties
      }
    >
      <button className="close" aria-label="Закрыть анализ" onClick={onClose}>
        ×
      </button>
      {loading ? (
        <div className="analysis-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <h3>Переводим в контексте…</h3>
        </div>
      ) : (
        analysis && (
          <>
            <div className="eyebrow">
              {demo ? "ДЕМО · ТЕСТОВЫЙ РЕЗУЛЬТАТ" : "ПЕРЕВОД В КОНТЕКСТЕ"}
            </div>
            <h2>{analysis.original_word}</h2>
            <ul
              className="compact-analysis-points"
              data-testid="compact-analysis"
            >
              <li className="contextual-meaning">
                <span className="point-label">В тексте: </span>
                <strong>{analysis.contextual_translation_ru}</strong>
              </li>
              {showDictionary && (
                <li>
                  <span className="point-label">Словарно: </span>
                  <span>{analysis.lemma}</span> — <span>{dictionary}</span>
                </li>
              )}
              {showLemma && (
                <li>
                  <span className="point-label">Начальная форма: </span>
                  <span>{analysis.lemma}</span>
                </li>
              )}
              {analysis.construction && (
                <li>
                  <span className="point-label">Конструкция: </span>
                  <span>{analysis.construction.text}</span>
                </li>
              )}
              {grammar.map((value) => (
                <li key={value}>{value}</li>
              ))}
              {analysis.usage_note_ru && <li>{analysis.usage_note_ru}</li>}
              {analysis.ambiguity_note_ru && (
                <li className="analysis-uncertainty">
                  {analysis.ambiguity_note_ru}
                </li>
              )}
            </ul>
            <button
              className="expand-meaning"
              onClick={openExpanded}
              disabled={expandedLoading}
              aria-expanded={showExpanded}
            >
              {expandedLoading
                ? "Объясняем значение…"
                : showExpanded
                  ? "Скрыть объяснение"
                  : "Подробнее о значении"}
            </button>
            {showExpanded && (
              <div
                className="expanded-meaning"
                data-testid="expanded-analysis"
                aria-live="polite"
              >
                {expandedLoading ? (
                  <div className="expanded-loading" role="status">
                    <span className="spinner" aria-hidden="true" />
                    <span>Объясняем значение…</span>
                  </div>
                ) : expandedError ? (
                  <div className="expanded-error" role="alert">
                    <p>{expandedError}</p>
                    <button className="secondary" onClick={onExpand}>
                      Повторить объяснение
                    </button>
                  </div>
                ) : expanded ? (
                  <ul className="expanded-analysis-points">
                    {expandedPoints.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
            <button
              className="primary save-word"
              onClick={onSave}
              disabled={saving || saved}
            >
              {saving
                ? "Сохраняем…"
                : saved
                  ? "✓ Уже в словаре"
                  : "＋ Добавить в словарь"}
            </button>
          </>
        )
      )}
    </section>
  );
}

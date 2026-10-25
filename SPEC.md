# Obsidian Skill Tree Plugin — Specification

## Goal

Create an Obsidian plugin that visualizes lessons as a prerequisite graph and derives each lesson's progress from multiple-choice questions and the existing [Obsidian Spaced Repetition plugin](https://github.com/st3v3nmw/obsidian-spaced-repetition).

The learning engine should be written in Rust and compiled to WebAssembly. TypeScript should provide the Obsidian entry point, views, events, data access, and WASM bindings.

**Out of scope:** XP, quests, currency, combat, achievements, streak rewards, or implementing a new spaced-repetition scheduler.

## Lesson node model

Each skill-tree node represents exactly one lesson (a Markdown note). A lesson has a stable `skill-id`, zero or more `skill-parents` (prerequisite node IDs), a quiz, and associated spaced-repetition flashcards.

Example frontmatter:

```yaml
---
skill-id: rust.ownership
skill-parents:
  - rust.variables
skill-quiz: quizzes/rust-ownership.json
---
```

Use IDs, not note paths, as graph identities so notes can be renamed. Report missing/duplicate IDs, missing prerequisites, and cycles instead of silently ignoring them. Prerequisite edges affect the graph; they do **not** independently determine node status.

## Exactly three visual states

1. **Gray** — the ABCD quiz has not been fully passed, including untouched or failed attempts. Track whether a lesson was attempted as separate metadata; do not create a fourth state.
2. **Understood** — every ABCD question in the current quiz was answered correctly within one completed quiz attempt. This remains the state while flashcards are not all mature.
3. **Learned** — the current quiz has been passed **and** the lesson has at least one associated flashcard, **all** of which are confirmed mature according to the spaced-repetition adapter.

Status priority: `LEARNED > UNDERSTOOD > GRAY`. Recompute from source data instead of storing a permanent learned flag. A newly added/unmatured/reset flashcard can bring a node from learned back to understood. Changing quiz content invalidates its recorded pass and may bring a node back to gray.

An absent quiz, unanswered question, empty flashcard set, or unknown maturity must **not** produce learned. Errors/unknown metadata should surface as diagnostics while retaining one of the three visual states.

## ABCD quizzes

- Store questions in a JSON file referenced by `skill-quiz`; do not require inline JSON in Markdown.
- Each question has a stable ID, prompt, exactly four choices (A/B/C/D), and exactly one correct choice.
- Require a *single perfect completed attempt* to pass the quiz. Failed attempts do not permanently advance the state.
- Persist the pass record keyed by skill ID and a fingerprint/version of the quiz content. Do not expose correct answers before submission.
- Store attempt metadata separately if useful for UI (e.g., last attempted timestamp); it is not a node status.

Example quiz document:

```json
{
  "questions": [
    {
      "id": "ownership-01",
      "prompt": "Who owns a moved String?",
      "choices": {
        "A": "The source binding",
        "B": "The destination binding",
        "C": "Both bindings",
        "D": "Neither binding"
      },
      "correct": "B"
    }
  ]
}
```

## Spaced repetition integration

Upstream: https://github.com/st3v3nmw/obsidian-spaced-repetition

- First inspect the upstream *current source code and tests* to establish actual card markup, scheduling formats, and the definition of a mature card.
- **Never** change or replace the upstream scheduler, and do not depend on undocumented internals such as `osrAppCore.fullDeckTree`.
- A lesson's associated cards should initially be the flashcards found in its Markdown note. Document limitations for cards stored elsewhere, and avoid mistaking ordinary Markdown for flashcards.
- Recognize every supported card format and the current SM-2/FSRS metadata *only after source inspection*. Do not hardcode an assumed comment schema.
- Prefer the upstream maturity definition if a stable, supported signal exists. Otherwise implement a documented, configurable fallback (suggested minimum scheduled interval: 21 days), with a deliberately conservative `unknown` outcome when scheduling metadata cannot be read safely.
- Require at least one associated card to earn learned. Treat missing cards and parsing errors as diagnostics, not as success.
- Recompute affected lessons when their notes, quiz files, or scheduling metadata change. Be mindful of Obsidian metadata/vault event ordering and avoid duplicate work.
- Never write the upstream scheduling metadata.

## Rust / TypeScript boundaries

**Rust crate, compiled to WASM:** serialize/deserialize domain data; validate graph topology; compute the three statuses; evaluate quiz attempts; compare quiz fingerprints; test progression and regression. Keep the core deterministic and independent of Obsidian.

**TypeScript Obsidian adapter:** plugin lifecycle; indexed discovery of skill notes; YAML frontmatter and Markdown reading; spaced-repetition compatibility adapter; vault change notifications; quiz and skill-tree views; persisted quiz attempt/pass records; WASM glue. The TS adapter supplies normalized card maturity data to Rust, rather than having Rust parse vault files directly.

Favor small, typed input/output DTOs so Rust tests can run without launching Obsidian. Treat unsupported upstream data as `unknown`, not silently mature.

## UI

- Display nodes and prerequisite edges in a zoomable/pannable or otherwise navigable graph.
- Gray = neutral, Understood = amber, Learned = green; use text/icon cues as well as color.
- Clicking a node opens the corresponding lesson; provide a clear way to start its quiz.
- Explain what remains before the next state (e.g., `4/5 cards mature`).
- Keep styling compatible with Obsidian themes and avoid introducing reward systems.

## Initial vertical slice / acceptance checks

1. A working Obsidian plugin skeleton with a Rust/WASM crate and TypeScript entry point.
2. Two connected lesson notes with valid metadata and sample quizzes.
3. A quiz view where only a perfect attempt yields Understood.
4. An adapter that reads existing upstream flashcard scheduling metadata without modifying it.
5. A node becoming Learned when **all** associated cards are mature, then regressing to Understood when one is reset.
6. Persistent quiz pass data across restarts, invalidated when quiz content changes.
7. Tests for untouched quiz, partial/failed quiz, perfect quiz, zero cards, mixed maturity, all mature, unknown maturity, changed quiz, duplicate IDs, missing parents, and cycles.
8. Documentation of build/test instructions and any upstream compatibility assumptions.

## Implementation approach for Codex

Inspect the repository and current upstream integration points first. Keep the existing project files intact, then incrementally scaffold the TypeScript Obsidian plugin and Rust/WASM architecture. Implement the smallest end-to-end path before adding advanced graph layout or caching. Run applicable checks and document incomplete parts honestly.

# Obsidian Skill Tree Plugin

Skill Tree is an Obsidian plugin for tracking lesson understanding. Each Markdown lesson has a stable ID, prerequisite IDs, an external ABCD quiz, and spaced-repetition flashcards. A small Rust learning engine is compiled to WebAssembly; TypeScript connects it to Obsidian.

## Development

Run `nix develop` to enter the development shell. It provides Rust with the WebAssembly target, `wasm-pack`, Node.js, and `rust-analyzer`.

```sh
npm install
npm run build
cargo test
cargo clippy
cargo fmt --check
```

`npm run build` builds the Rust WebAssembly module, type-checks the Obsidian adapter, and writes the runnable plugin files into `plugin/`. Copy that folder to `<vault>/.obsidian/plugins/skill-tree/`, then enable Skill Tree in Obsidian. To use the examples, copy the contents of `examples/Lessons` into a vault `Lessons/` folder and the contents of `examples/quizzes` into a vault `quizzes/` folder.

The two example lessons connect Rust variables to ownership. Start with a gray node, submit a perfect quiz attempt to reach Understood, then schedule every associated card for at least 32 days to reach Learned.

## Lesson metadata

```yaml
---
skill-id: rust.ownership
skill-parents:
  - rust.variables
skill-quiz: quizzes/rust-ownership.json
tags:
  - flashcards
---
```

`skill-id` is the stable graph identity; prerequisite edges use IDs rather than note paths. A skill note needs a nonempty ID, a quiz JSON file, and a spaced-repetition deck tag. Missing IDs, duplicate IDs, missing prerequisites, invalid quizzes, and prerequisite cycles appear as diagnostics.

Quiz files contain a nonempty `questions` array. Every question has a unique `id`, a `prompt`, exactly the `A`, `B`, `C`, and `D` choice keys, and a `correct` key. A single completed attempt must answer every question correctly. The UI only receives questions and choices before submission; the Rust engine grades the hidden key. Passes are saved by skill ID with a SHA-256 fingerprint of the validated quiz. Changing quiz content invalidates the saved pass. Attempt timestamps are stored separately.

## Progress states

- **Gray:** no matching perfect quiz pass exists.
- **Understood:** the current quiz has a matching perfect pass, but one or more flashcards are not mature.
- **Learned:** the current quiz has a matching perfect pass, there is at least one associated flashcard, and every card is mature.

Statuses are derived each time the vault data is recomputed. New or reset cards can move a node from Learned back to Understood. An empty card set or unknown schedule never counts as Learned. Prerequisites affect graph edges and diagnostics; they do not change a node's status.

## Spaced-repetition compatibility

The adapter was checked against the upstream source and tests at commit [`3d5079f`](https://github.com/st3v3nmw/obsidian-spaced-repetition/tree/3d5079f). It recognizes the default `#flashcards` deck tag, single-line `::` and reversible `:::` cards, multiline `?` and reversible `??` cards, and the default highlighted cloze form `==answer==`. It ignores fenced code and requires the note to be in the default flashcard deck.

The adapter reads schedule comments in lesson Markdown and does not write scheduling metadata. It understands the current SM-2/OSR segments (`due-date,interval,ease`) and FSRS segments (`fsrs,due,interval,stability,difficulty,state,reps,lapses,learning-steps,last-review`), including sibling schedules. An absent schedule or the upstream `2000-01-01` new-card placeholder means Immature. A malformed schedule is Unknown.

Upstream's `Stats.update()` currently classifies cards with an interval of **32 days or more** as mature; its statistics page describes mature cards as having intervals over one month. The plugin uses that source-backed display cutoff as its fallback because upstream does not expose a separate stable maturity API. It applies the cutoff to both current scheduler formats, where the interval is the scheduled day count. This is a conservative adapter to the checked source version, not a promise that future upstream versions will keep the same schema.

The adapter only uses the upstream default card separators, cloze syntax, and deck tag. Custom separators, user-defined cloze patterns, folder-derived decks, and scheduling data stored outside the lesson Markdown are not discovered. The upstream repository currently documents external schedule storage as work in progress; this plugin does not read its private plugin data or `fullDeckTree`. Unsupported scheduling metadata remains Unknown. Cards in other notes are not associated with a lesson.

References: [upstream card parser](https://github.com/st3v3nmw/obsidian-spaced-repetition/blob/3d5079f/src/parser.ts), [default settings](https://github.com/st3v3nmw/obsidian-spaced-repetition/blob/3d5079f/src/data/settings.ts), [scheduling comment parser](https://github.com/st3v3nmw/obsidian-spaced-repetition/blob/3d5079f/src/utils/comment-parser.ts), [mature-card statistics](https://github.com/st3v3nmw/obsidian-spaced-repetition/blob/3d5079f/src/data/data-structures/deck/stats.ts), and [schedule storage notes](https://github.com/st3v3nmw/obsidian-spaced-repetition/blob/3d5079f/src/data/data-store/README.md).

## Structure

- `src/lib.rs` contains deterministic quiz, fingerprint, graph, diagnostics, and status logic and its Rust tests.
- `plugin/src/` contains the Obsidian adapter, quiz UI, navigable SVG prerequisite graph, and compatibility parser.
- `examples/` contains two connected lessons and external quizzes.

The graph refreshes after note, quiz, create, delete, rename, and metadata-cache changes. Events are debounced to avoid repeated vault scans. Nodes show card progress and diagnostic messages; clicking a node opens its lesson and the detail panel starts its quiz.

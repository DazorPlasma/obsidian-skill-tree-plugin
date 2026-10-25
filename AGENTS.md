# Codex instructions

Implement the Obsidian knowledge skill-tree plugin described in [SPEC.md](SPEC.md).

Read the spec and inspect the current upstream Obsidian Spaced Repetition repository before changing architecture or parsing its metadata. Keep the Rust core independent from Obsidian and use a minimal TypeScript adapter for host integration. Make changes in small testable increments.

Prioritize correctness of Gray → Understood → Learned, including regression, quiz invalidation, and unknown maturity. Do **not** add XP, quests, or other gamification features. Do not modify scheduling metadata managed by the upstream plugin.

This project was created using `cargo new`; `src/main.rs` is only the initial Cargo template, not the final plugin architecture.

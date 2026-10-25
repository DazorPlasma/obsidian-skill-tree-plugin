---
skill-id: rust.ownership
skill-parents:
  - rust.variables
skill-quiz: quizzes/rust-ownership.json
tags:
  - flashcards
---

# Ownership

Rust ownership tracks who is responsible for a value's memory.

What happens to a `String` after it is moved?::The destination binding becomes its owner.

The stack stores a pointer, length, and capacity for a `String`.
?
The string's bytes live in a heap allocation.


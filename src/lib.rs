use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Quiz {
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub prompt: String,
    pub choices: BTreeMap<String, String>,
    pub correct: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicQuestion {
    pub id: String,
    pub prompt: String,
    pub choices: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicQuiz {
    pub questions: Vec<PublicQuestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GradeResult {
    pub complete: bool,
    pub perfect: bool,
    pub answered: usize,
    pub correct: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CardMaturity {
    Mature,
    Immature,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LessonInput {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub parents: Vec<String>,
    #[serde(default)]
    pub quiz: Option<Quiz>,
    #[serde(default)]
    pub quiz_error: Option<String>,
    #[serde(default)]
    pub passed_fingerprint: Option<String>,
    #[serde(default)]
    pub attempted: bool,
    #[serde(default)]
    pub cards: Vec<CardMaturity>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Gray,
    Understood,
    Learned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub node_id: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NodeResult {
    pub id: String,
    pub path: String,
    pub title: String,
    pub parents: Vec<String>,
    pub status: NodeStatus,
    pub attempted: bool,
    pub mature_cards: usize,
    pub total_cards: usize,
    pub unknown_cards: usize,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphResult {
    pub nodes: Vec<NodeResult>,
    pub diagnostics: Vec<Diagnostic>,
}

fn validate_quiz(quiz: &Quiz) -> Result<(), String> {
    if quiz.questions.is_empty() {
        return Err("A quiz must contain at least one question.".into());
    }

    let expected: BTreeSet<&str> = ["A", "B", "C", "D"].into_iter().collect();
    let mut ids = BTreeSet::new();
    for (index, question) in quiz.questions.iter().enumerate() {
        let number = index + 1;
        if question.id.trim().is_empty() {
            return Err(format!("Question {number} has an empty ID."));
        }
        if !ids.insert(question.id.as_str()) {
            return Err(format!("Question ID '{}' is duplicated.", question.id));
        }
        if question.prompt.trim().is_empty() {
            return Err(format!("Question '{}' has an empty prompt.", question.id));
        }
        if question.choices.len() != 4
            || question
                .choices
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>()
                != expected
        {
            return Err(format!(
                "Question '{}' must have exactly the A, B, C, and D choices.",
                question.id
            ));
        }
        if question
            .choices
            .values()
            .any(|choice| choice.trim().is_empty())
        {
            return Err(format!("Question '{}' has an empty choice.", question.id));
        }
        if !expected.contains(question.correct.as_str()) {
            return Err(format!(
                "Question '{}' must have one correct choice from A through D.",
                question.id
            ));
        }
    }
    Ok(())
}

pub fn quiz_fingerprint_for(quiz: &Quiz) -> Result<String, String> {
    validate_quiz(quiz)?;
    let canonical = serde_json::to_vec(quiz).map_err(|error| error.to_string())?;
    let digest = Sha256::digest(canonical);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn public_quiz(quiz: &Quiz) -> Result<PublicQuiz, String> {
    validate_quiz(quiz)?;
    Ok(PublicQuiz {
        questions: quiz
            .questions
            .iter()
            .map(|question| PublicQuestion {
                id: question.id.clone(),
                prompt: question.prompt.clone(),
                choices: question.choices.clone(),
            })
            .collect(),
    })
}

pub fn grade_attempt(
    quiz: &Quiz,
    answers: &BTreeMap<String, String>,
) -> Result<GradeResult, String> {
    validate_quiz(quiz)?;
    let mut answered = 0;
    let mut correct = 0;

    for question in &quiz.questions {
        if let Some(answer) = answers.get(&question.id)
            && question.choices.contains_key(answer)
        {
            answered += 1;
            if answer == &question.correct {
                correct += 1;
            }
        }
    }

    let total = quiz.questions.len();
    let complete = answered == total && answers.len() == total;
    Ok(GradeResult {
        complete,
        perfect: complete && correct == total,
        answered,
        correct,
        total,
    })
}

fn diagnostic(code: &str, message: String, id: Option<&str>, path: Option<&str>) -> Diagnostic {
    Diagnostic {
        code: code.to_string(),
        message,
        node_id: id.map(str::to_owned),
        path: path.map(str::to_owned),
    }
}

pub fn analyze_graph(lessons: Vec<LessonInput>) -> GraphResult {
    let mut diagnostics = Vec::new();
    let mut id_to_indices: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, lesson) in lessons.iter().enumerate() {
        if lesson.id.trim().is_empty() {
            diagnostics.push(diagnostic(
                "missing-skill-id",
                "Skill note has no non-empty skill-id.".into(),
                None,
                Some(&lesson.path),
            ));
        } else {
            id_to_indices
                .entry(lesson.id.clone())
                .or_default()
                .push(index);
        }
    }

    for (id, indices) in &id_to_indices {
        if indices.len() > 1 {
            let paths = indices
                .iter()
                .map(|index| lessons[*index].path.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            diagnostics.push(diagnostic(
                "duplicate-skill-id",
                format!("Skill ID '{id}' is used by multiple notes: {paths}."),
                Some(id),
                None,
            ));
        }
    }

    let mut node_diagnostics = vec![Vec::new(); lessons.len()];
    for (index, lesson) in lessons.iter().enumerate() {
        if lesson.id.trim().is_empty() {
            node_diagnostics[index].push(diagnostic(
                "missing-skill-id",
                "Add a stable skill-id to this note's frontmatter.".into(),
                None,
                Some(&lesson.path),
            ));
        }
        if id_to_indices
            .get(&lesson.id)
            .is_some_and(|indices| indices.len() > 1)
        {
            node_diagnostics[index].push(diagnostic(
                "duplicate-skill-id",
                format!("Skill ID '{}' is duplicated.", lesson.id),
                Some(&lesson.id),
                Some(&lesson.path),
            ));
        }

        for parent in &lesson.parents {
            match id_to_indices.get(parent) {
                None => {
                    let item = diagnostic(
                        "missing-parent",
                        format!("Prerequisite '{parent}' does not exist."),
                        Some(&lesson.id),
                        Some(&lesson.path),
                    );
                    diagnostics.push(item.clone());
                    node_diagnostics[index].push(item);
                }
                Some(indices) if indices.len() > 1 => {
                    let item = diagnostic(
                        "ambiguous-parent",
                        format!("Prerequisite '{parent}' has a duplicate skill-id."),
                        Some(&lesson.id),
                        Some(&lesson.path),
                    );
                    diagnostics.push(item.clone());
                    node_diagnostics[index].push(item);
                }
                _ => {}
            }
        }

        match &lesson.quiz {
            None => node_diagnostics[index].push(diagnostic(
                if lesson.quiz_error.is_some() {
                    "invalid-quiz"
                } else {
                    "missing-quiz"
                },
                lesson
                    .quiz_error
                    .clone()
                    .unwrap_or_else(|| "No quiz is linked to this skill.".into()),
                Some(&lesson.id),
                Some(&lesson.path),
            )),
            Some(quiz) => {
                if let Err(message) = validate_quiz(quiz) {
                    node_diagnostics[index].push(diagnostic(
                        "invalid-quiz",
                        message,
                        Some(&lesson.id),
                        Some(&lesson.path),
                    ));
                }
            }
        }

        if lesson.cards.is_empty() {
            node_diagnostics[index].push(diagnostic(
                "no-flashcards",
                "No associated spaced-repetition cards were found.".into(),
                Some(&lesson.id),
                Some(&lesson.path),
            ));
        }
        if lesson.cards.contains(&CardMaturity::Unknown) {
            node_diagnostics[index].push(diagnostic(
                "unknown-card-maturity",
                "Some flashcard scheduling data could not be read safely.".into(),
                Some(&lesson.id),
                Some(&lesson.path),
            ));
        }
    }

    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for lesson in &lessons {
        if id_to_indices
            .get(&lesson.id)
            .is_some_and(|indices| indices.len() == 1)
        {
            for parent in &lesson.parents {
                if id_to_indices
                    .get(parent)
                    .is_some_and(|indices| indices.len() == 1)
                {
                    children
                        .entry(parent.clone())
                        .or_default()
                        .push(lesson.id.clone());
                }
            }
        }
    }
    for child_nodes in children.values_mut() {
        child_nodes.sort();
        child_nodes.dedup();
    }
    let cyclic_ids = find_cycles(&children);
    for id in &cyclic_ids {
        let item = diagnostic(
            "cycle",
            format!("Skill '{id}' is part of a prerequisite cycle."),
            Some(id),
            id_to_indices
                .get(id)
                .and_then(|indices| indices.first())
                .map(|index| lessons[*index].path.as_str()),
        );
        diagnostics.push(item.clone());
        if let Some(index) = id_to_indices.get(id).and_then(|indices| indices.first()) {
            node_diagnostics[*index].push(item);
        }
    }

    let nodes = lessons
        .iter()
        .enumerate()
        .map(|(index, lesson)| {
            let fingerprint = lesson
                .quiz
                .as_ref()
                .and_then(|quiz| quiz_fingerprint_for(quiz).ok());
            let unique_id = id_to_indices
                .get(&lesson.id)
                .is_some_and(|indices| indices.len() == 1);
            let quiz_passed =
                unique_id && fingerprint.is_some() && fingerprint == lesson.passed_fingerprint;
            let status = if !quiz_passed {
                NodeStatus::Gray
            } else if !lesson.cards.is_empty()
                && lesson
                    .cards
                    .iter()
                    .all(|card| *card == CardMaturity::Mature)
            {
                NodeStatus::Learned
            } else {
                NodeStatus::Understood
            };
            let mature_cards = lesson
                .cards
                .iter()
                .filter(|card| **card == CardMaturity::Mature)
                .count();
            let unknown_cards = lesson
                .cards
                .iter()
                .filter(|card| **card == CardMaturity::Unknown)
                .count();
            NodeResult {
                id: lesson.id.clone(),
                path: lesson.path.clone(),
                title: if lesson.title.trim().is_empty() {
                    lesson.id.clone()
                } else {
                    lesson.title.clone()
                },
                parents: lesson.parents.clone(),
                status,
                attempted: lesson.attempted,
                mature_cards,
                total_cards: lesson.cards.len(),
                unknown_cards,
                diagnostics: node_diagnostics[index].clone(),
            }
        })
        .collect();

    GraphResult { nodes, diagnostics }
}

fn find_cycles(children: &BTreeMap<String, Vec<String>>) -> BTreeSet<String> {
    struct Tarjan<'a> {
        children: &'a BTreeMap<String, Vec<String>>,
        indices: BTreeMap<String, usize>,
        lowlinks: BTreeMap<String, usize>,
        stack: Vec<String>,
        on_stack: BTreeSet<String>,
        cycles: BTreeSet<String>,
        next_index: usize,
    }

    impl Tarjan<'_> {
        fn visit(&mut self, node: &str) {
            let index = self.next_index;
            self.next_index += 1;
            self.indices.insert(node.to_owned(), index);
            self.lowlinks.insert(node.to_owned(), index);
            self.stack.push(node.to_owned());
            self.on_stack.insert(node.to_owned());

            let next_nodes = self.children.get(node).cloned().unwrap_or_default();
            for next in next_nodes {
                if !self.indices.contains_key(&next) {
                    self.visit(&next);
                    let next_lowlink = self.lowlinks[&next];
                    let node_lowlink = self.lowlinks[node];
                    self.lowlinks
                        .insert(node.to_owned(), node_lowlink.min(next_lowlink));
                } else if self.on_stack.contains(&next) {
                    let next_index = self.indices[&next];
                    let node_lowlink = self.lowlinks[node];
                    self.lowlinks
                        .insert(node.to_owned(), node_lowlink.min(next_index));
                }
            }

            if self.lowlinks[node] == self.indices[node] {
                let mut component = Vec::new();
                while let Some(member) = self.stack.pop() {
                    self.on_stack.remove(&member);
                    let is_root = member == node;
                    component.push(member);
                    if is_root {
                        break;
                    }
                }
                if component.len() > 1
                    || self
                        .children
                        .get(node)
                        .is_some_and(|next_nodes| next_nodes.iter().any(|next| next == node))
                {
                    self.cycles.extend(component);
                }
            }
        }
    }

    let mut nodes = BTreeSet::new();
    nodes.extend(children.keys().cloned());
    for next_nodes in children.values() {
        nodes.extend(next_nodes.iter().cloned());
    }
    let mut tarjan = Tarjan {
        children,
        indices: BTreeMap::new(),
        lowlinks: BTreeMap::new(),
        stack: Vec::new(),
        on_stack: BTreeSet::new(),
        cycles: BTreeSet::new(),
        next_index: 0,
    };
    for node in nodes {
        if !tarjan.indices.contains_key(&node) {
            tarjan.visit(&node);
        }
    }
    tarjan.cycles
}

fn parse_quiz_json(input: &str) -> Result<Quiz, String> {
    let quiz: Quiz = serde_json::from_str(input).map_err(|error| error.to_string())?;
    validate_quiz(&quiz)?;
    Ok(quiz)
}

fn to_js_error(message: String) -> JsValue {
    JsValue::from_str(&message)
}

#[wasm_bindgen]
pub fn quiz_fingerprint(quiz_json: &str) -> Result<String, JsValue> {
    let quiz = parse_quiz_json(quiz_json).map_err(to_js_error)?;
    quiz_fingerprint_for(&quiz).map_err(to_js_error)
}

#[wasm_bindgen]
pub fn public_quiz_json(quiz_json: &str) -> Result<String, JsValue> {
    let quiz = parse_quiz_json(quiz_json).map_err(to_js_error)?;
    let public = public_quiz(&quiz).map_err(to_js_error)?;
    serde_json::to_string(&public).map_err(|error| to_js_error(error.to_string()))
}

#[wasm_bindgen]
pub fn grade_quiz_json(quiz_json: &str, answers_json: &str) -> Result<String, JsValue> {
    let quiz = parse_quiz_json(quiz_json).map_err(to_js_error)?;
    let answers: BTreeMap<String, String> =
        serde_json::from_str(answers_json).map_err(|error| to_js_error(error.to_string()))?;
    let result = grade_attempt(&quiz, &answers).map_err(to_js_error)?;
    serde_json::to_string(&result).map_err(|error| to_js_error(error.to_string()))
}

#[wasm_bindgen]
pub fn analyze_graph_json(input_json: &str) -> Result<String, JsValue> {
    let lessons: Vec<LessonInput> =
        serde_json::from_str(input_json).map_err(|error| to_js_error(error.to_string()))?;
    let graph = analyze_graph(lessons);
    serde_json::to_string(&graph).map_err(|error| to_js_error(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_quiz() -> Quiz {
        Quiz {
            questions: vec![Question {
                id: "q1".into(),
                prompt: "Which letter is first?".into(),
                choices: BTreeMap::from([
                    ("A".into(), "A".into()),
                    ("B".into(), "B".into()),
                    ("C".into(), "C".into()),
                    ("D".into(), "D".into()),
                ]),
                correct: "A".into(),
            }],
        }
    }

    fn lesson(cards: Vec<CardMaturity>, passed: bool) -> LessonInput {
        let quiz = sample_quiz();
        LessonInput {
            id: "rust.ownership".into(),
            path: "Lessons/Ownership.md".into(),
            title: "Ownership".into(),
            parents: vec![],
            passed_fingerprint: passed.then(|| quiz_fingerprint_for(&quiz).unwrap()),
            quiz: Some(quiz),
            quiz_error: None,
            attempted: false,
            cards,
        }
    }

    #[test]
    fn untouched_and_failed_quizzes_stay_gray() {
        assert_eq!(
            analyze_graph(vec![lesson(vec![], false)]).nodes[0].status,
            NodeStatus::Gray
        );
        assert_eq!(
            analyze_graph(vec![lesson(vec![CardMaturity::Mature], false)]).nodes[0].status,
            NodeStatus::Gray
        );
    }

    #[test]
    fn one_perfect_completed_attempt_passes() {
        let quiz = sample_quiz();
        let partial = BTreeMap::new();
        assert!(!grade_attempt(&quiz, &partial).unwrap().complete);
        let failed = BTreeMap::from([("q1".into(), "B".into())]);
        assert!(!grade_attempt(&quiz, &failed).unwrap().perfect);
        let perfect = BTreeMap::from([("q1".into(), "A".into())]);
        assert!(grade_attempt(&quiz, &perfect).unwrap().perfect);
    }

    #[test]
    fn quiz_pass_requires_a_nonempty_quiz_with_abcd_choices() {
        let invalid = Quiz { questions: vec![] };
        assert!(quiz_fingerprint_for(&invalid).is_err());
        let mut invalid = sample_quiz();
        invalid.questions[0].choices.remove("D");
        assert!(quiz_fingerprint_for(&invalid).is_err());
    }

    #[test]
    fn empty_flashcard_set_never_becomes_learned() {
        let node = analyze_graph(vec![lesson(vec![], true)]).nodes.remove(0);
        assert_eq!(node.status, NodeStatus::Understood);
        assert!(
            node.diagnostics
                .iter()
                .any(|item| item.code == "no-flashcards")
        );
    }

    #[test]
    fn mixed_or_unknown_maturity_stays_understood_and_reports_progress() {
        let node = analyze_graph(vec![lesson(
            vec![
                CardMaturity::Mature,
                CardMaturity::Immature,
                CardMaturity::Unknown,
            ],
            true,
        )])
        .nodes
        .remove(0);
        assert_eq!(node.status, NodeStatus::Understood);
        assert_eq!(node.mature_cards, 1);
        assert_eq!(node.total_cards, 3);
        assert_eq!(node.unknown_cards, 1);
    }

    #[test]
    fn all_mature_cards_become_learned_and_reset_regresses() {
        let learned = analyze_graph(vec![lesson(vec![CardMaturity::Mature], true)])
            .nodes
            .remove(0);
        assert_eq!(learned.status, NodeStatus::Learned);
        let reset = analyze_graph(vec![lesson(vec![CardMaturity::Immature], true)])
            .nodes
            .remove(0);
        assert_eq!(reset.status, NodeStatus::Understood);
    }

    #[test]
    fn changed_quiz_content_invalidates_the_saved_pass() {
        let mut item = lesson(vec![CardMaturity::Mature], true);
        item.quiz.as_mut().unwrap().questions[0].prompt = "Changed question".into();
        assert_eq!(analyze_graph(vec![item]).nodes[0].status, NodeStatus::Gray);
    }

    #[test]
    fn duplicate_ids_missing_parents_and_cycles_are_reported() {
        let mut first = lesson(vec![], true);
        first.id = "a".into();
        first.parents = vec!["b".into(), "missing".into()];
        let mut second = lesson(vec![], true);
        second.id = "a".into();
        let mut third = lesson(vec![], false);
        third.id = "b".into();
        third.parents = vec!["a".into()];
        let result = analyze_graph(vec![first, second, third]);
        let codes: BTreeSet<String> = result
            .diagnostics
            .iter()
            .map(|item| item.code.clone())
            .collect();
        assert!(codes.contains("duplicate-skill-id"));
        assert!(codes.contains("missing-parent"));
        assert!(!codes.contains("cycle")); // Duplicate IDs make the a edge ambiguous.
        assert_eq!(result.nodes[0].status, NodeStatus::Gray);
        assert_eq!(result.nodes[1].status, NodeStatus::Gray);

        let mut a = lesson(vec![], false);
        a.id = "a".into();
        a.parents = vec!["b".into()];
        let mut b = lesson(vec![], false);
        b.id = "b".into();
        b.parents = vec!["a".into()];
        let cycle = analyze_graph(vec![a, b]);
        assert!(cycle.diagnostics.iter().any(|item| item.code == "cycle"));
    }

    #[test]
    fn overlapping_cycles_report_every_member_in_stable_order() {
        let mut a = lesson(vec![], false);
        a.id = "a".into();
        a.parents = vec!["b".into()];
        let mut b = lesson(vec![], false);
        b.id = "b".into();
        b.parents = vec!["a".into(), "c".into()];
        let mut c = lesson(vec![], false);
        c.id = "c".into();
        c.parents = vec!["b".into()];

        let input = vec![a, b, c];
        let result = analyze_graph(input.clone());
        let cycle_ids: Vec<&str> = result
            .diagnostics
            .iter()
            .filter(|item| item.code == "cycle")
            .filter_map(|item| item.node_id.as_deref())
            .collect();
        assert_eq!(cycle_ids, vec!["a", "b", "c"]);
        assert_eq!(
            serde_json::to_string(&result).unwrap(),
            serde_json::to_string(&analyze_graph(input)).unwrap()
        );
    }

    #[test]
    fn missing_skill_ids_are_reported_without_assigning_a_status_from_cards() {
        let mut item = lesson(vec![CardMaturity::Mature], true);
        item.id.clear();
        let result = analyze_graph(vec![item]);
        assert_eq!(result.nodes[0].status, NodeStatus::Gray);
        assert!(
            result
                .diagnostics
                .iter()
                .any(|item| item.code == "missing-skill-id")
        );
    }

    #[test]
    fn public_quiz_never_contains_the_answer_key() {
        let public = serde_json::to_string(&public_quiz(&sample_quiz()).unwrap()).unwrap();
        assert!(!public.contains("correct"));
    }
}

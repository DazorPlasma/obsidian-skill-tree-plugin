import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

import {
  analyze_graph_json,
  grade_quiz_json,
  public_quiz_json,
  quiz_fingerprint,
  default as initWasm,
} from "../pkg/skill_tree_core";
import wasmBinary from "../pkg/skill_tree_core_bg.wasm";
import { isSpacedRepetitionDeck, readCardMaturities, type CardMaturity } from "./cards";

const VIEW_TYPE = "skill-tree-view";

interface QuizChoice {
  A: string;
  B: string;
  C: string;
  D: string;
}

interface PublicQuiz {
  questions: Array<{ id: string; prompt: string; choices: QuizChoice }>;
}

interface GradeResult {
  complete: boolean;
  perfect: boolean;
  answered: number;
  correct: number;
  total: number;
}

interface Diagnostic {
  code: string;
  message: string;
  node_id: string | null;
  path: string | null;
}

interface SkillNode {
  id: string;
  path: string;
  title: string;
  parents: string[];
  status: "gray" | "understood" | "learned";
  attempted: boolean;
  mature_cards: number;
  total_cards: number;
  unknown_cards: number;
  diagnostics: Diagnostic[];
}

interface GraphResult {
  nodes: SkillNode[];
  diagnostics: Diagnostic[];
}

interface LessonInput {
  id: string;
  path: string;
  title: string;
  parents: string[];
  quiz: unknown | null;
  quiz_error: string | null;
  passed_fingerprint: string | null;
  attempted: boolean;
  cards: CardMaturity[];
}

interface StoredData {
  passes: Record<string, string>;
  attempts: Record<string, string>;
}

function frontmatterString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function frontmatterParents(value: unknown): string[] {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return values.filter((parent): parent is string => typeof parent === "string" && parent.trim().length > 0).map((parent) => parent.trim());
}

function isSkillCandidate(frontmatter: Record<string, unknown> | undefined): boolean {
  if (!frontmatter) return false;
  return ["skill-id", "skill-parents", "skill-quiz"].some((field) => field in frontmatter);
}

function fileTitle(file: TFile): string {
  return file.basename.replace(/[-_]/g, " ");
}

function getStoredData(value: unknown): StoredData {
  if (!value || typeof value !== "object") return { passes: {}, attempts: {} };
  const record = value as Record<string, unknown>;
  const stringMap = (item: unknown): Record<string, string> => {
    if (!item || typeof item !== "object") return {};
    return Object.fromEntries(
      Object.entries(item).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  };
  return { passes: stringMap(record.passes), attempts: stringMap(record.attempts) };
}

function statusLabel(status: SkillNode["status"]): string {
  return status === "learned" ? "Learned" : status === "understood" ? "Understood" : "Gray";
}

function statusSymbol(status: SkillNode["status"]): string {
  return status === "learned" ? "●" : status === "understood" ? "◐" : "○";
}

function diagnosticText(diagnostic: Diagnostic): string {
  return diagnostic.path ? `${diagnostic.message} (${diagnostic.path})` : diagnostic.message;
}

function nodeDepth(
  node: SkillNode,
  nodesById: Map<string, SkillNode>,
  memo: Map<string, number>,
  visiting: Set<string>,
): number {
  const cached = memo.get(node.path);
  if (cached !== undefined) return cached;
  if (node.diagnostics.some((item) => item.code === "cycle")) {
    memo.set(node.path, 0);
    return 0;
  }
  if (visiting.has(node.path)) return 0;
  visiting.add(node.path);
  let depth = 0;
  for (const parentId of node.parents) {
    const parent = nodesById.get(parentId);
    if (parent) depth = Math.max(depth, nodeDepth(parent, nodesById, memo, visiting) + 1);
  }
  visiting.delete(node.path);
  memo.set(node.path, depth);
  return depth;
}

class SkillTreeView extends ItemView {
  private graph: GraphResult = { nodes: [], diagnostics: [] };
  private selectedPath: string | null = null;
  private onOpenNote: (path: string) => Promise<void>;
  private onStartQuiz: (node: SkillNode) => Promise<void>;
  private zoom = 1;
  private pan = { x: 0, y: 0 };

  constructor(
    leaf: WorkspaceLeaf,
    onOpenNote: (path: string) => Promise<void>,
    onStartQuiz: (node: SkillNode) => Promise<void>,
  ) {
    super(leaf);
    this.onOpenNote = onOpenNote;
    this.onStartQuiz = onStartQuiz;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Skill Tree";
  }

  getIcon(): string {
    return "git-branch";
  }

  setGraph(graph: GraphResult): void {
    this.graph = graph;
    if (!this.selectedPath || !graph.nodes.some((node) => node.path === this.selectedPath)) {
      this.selectedPath = graph.nodes[0]?.path ?? null;
    }
    this.render();
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("skill-tree-view");
    const heading = root.createDiv({ cls: "skill-tree-heading" });
    heading.createEl("h2", { text: "Skill Tree" });
    heading.createEl("p", { text: "Pass each lesson quiz, then mature every linked flashcard." });

    const controls = root.createDiv({ cls: "skill-tree-controls" });
    controls.createEl("label", { text: "Zoom" });
    const zoom = controls.createEl("input", { attr: { type: "range", min: "0.55", max: "1.7", step: "0.05", value: String(this.zoom) } });
    zoom.addEventListener("input", () => {
      this.zoom = Number(zoom.value);
      this.updateTransform(root);
    });
    const reset = controls.createEl("button", { text: "Center graph" });
    reset.addEventListener("click", () => {
      this.pan = { x: 0, y: 0 };
      this.zoom = 1;
      zoom.value = "1";
      this.updateTransform(root);
    });

    if (this.graph.nodes.length === 0) {
      root.createEl("p", { cls: "skill-tree-empty", text: "Add skill-id, skill-parents, and skill-quiz frontmatter to a lesson note to start." });
    } else {
      this.renderGraph(root);
      this.renderDetails(root);
    }
    this.renderDiagnostics(root);
  }

  private renderGraph(root: HTMLElement): void {
    const container = root.createDiv({ cls: "skill-tree-canvas-container" });
    const nodesById = new Map<string, SkillNode>();
    const idCounts = new Map<string, number>();
    for (const node of this.graph.nodes) {
      if (node.id) idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
    }
    for (const node of this.graph.nodes) {
      if (node.id && idCounts.get(node.id) === 1) nodesById.set(node.id, node);
    }
    const grouped = new Map<number, SkillNode[]>();
    const depthMemo = new Map<string, number>();
    for (const node of this.graph.nodes) {
      const depth = nodeDepth(node, nodesById, depthMemo, new Set());
      grouped.set(depth, [...(grouped.get(depth) ?? []), node]);
    }
    const positions = new Map<string, { x: number; y: number }>();
    const maxRows = Math.max(...[...grouped.values()].map((items) => items.length), 1);
    for (const [depth, items] of grouped) {
      items.forEach((node, row) => {
        positions.set(node.path, { x: 100 + depth * 250, y: 70 + row * 150 });
      });
    }
    const width = Math.max(460, 220 + (Math.max(...grouped.keys(), 0) + 1) * 250);
    const height = 130 + maxRows * 150;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", "Lesson prerequisite graph. Drag to pan.");
    svg.classList.add("skill-tree-canvas");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "skill-tree-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.classList.add("skill-tree-arrow");
    marker.append(arrow);
    defs.append(marker);
    svg.append(defs);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add("skill-tree-graph-content");
    svg.append(group);

    for (const node of this.graph.nodes) {
      const target = positions.get(node.path);
      if (!target) continue;
      for (const parentId of node.parents) {
        const parent = nodesById.get(parentId);
        const source = parent ? positions.get(parent.path) : undefined;
        if (!source) continue;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const startX = source.x + 41;
        const endX = target.x - 41;
        line.setAttribute("d", `M ${startX} ${source.y} C ${startX + 70} ${source.y}, ${endX - 70} ${target.y}, ${endX} ${target.y}`);
        line.classList.add("skill-tree-edge");
        group.append(line);
      }
    }

    for (const node of this.graph.nodes) {
      const point = positions.get(node.path);
      if (!point) continue;
      const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      nodeGroup.classList.add("skill-tree-node", `status-${node.status}`);
      if (this.selectedPath === node.path) nodeGroup.classList.add("is-selected");
      nodeGroup.setAttribute("transform", `translate(${point.x} ${point.y})`);
      nodeGroup.setAttribute("role", "button");
      nodeGroup.setAttribute("tabindex", "0");
      nodeGroup.setAttribute("aria-label", `${node.title}, ${statusLabel(node.status)}. Open lesson.`);
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", "37");
      nodeGroup.append(circle);
      const symbol = document.createElementNS("http://www.w3.org/2000/svg", "text");
      symbol.setAttribute("text-anchor", "middle");
      symbol.setAttribute("dy", "7");
      symbol.classList.add("skill-tree-symbol");
      symbol.textContent = statusSymbol(node.status);
      nodeGroup.append(symbol);
      const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
      title.setAttribute("text-anchor", "middle");
      title.setAttribute("y", "58");
      title.classList.add("skill-tree-node-title");
      title.textContent = node.title.length > 24 ? `${node.title.slice(0, 21)}…` : node.title;
      nodeGroup.append(title);
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("y", "77");
      label.classList.add("skill-tree-node-status");
      label.textContent = statusLabel(node.status);
      nodeGroup.append(label);
      nodeGroup.addEventListener("click", () => {
        this.selectedPath = node.path;
        void this.onOpenNote(node.path);
        this.render();
      });
      nodeGroup.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.selectedPath = node.path;
          void this.onOpenNote(node.path);
          this.render();
        }
      });
      group.append(nodeGroup);
    }

    let dragStart: { x: number; y: number; panX: number; panY: number } | null = null;
    svg.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest("g.skill-tree-node")) return;
      dragStart = { x: event.clientX, y: event.clientY, panX: this.pan.x, panY: this.pan.y };
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener("pointermove", (event) => {
      if (!dragStart) return;
      this.pan = { x: dragStart.panX + event.clientX - dragStart.x, y: dragStart.panY + event.clientY - dragStart.y };
      this.updateTransform(root);
    });
    svg.addEventListener("pointerup", () => {
      dragStart = null;
    });
    svg.addEventListener("pointercancel", () => {
      dragStart = null;
    });
    container.append(svg);
    this.updateTransform(root);
  }

  private updateTransform(root: HTMLElement): void {
    const group = root.querySelector<SVGGElement>(".skill-tree-graph-content");
    if (group) group.setAttribute("transform", `translate(${this.pan.x} ${this.pan.y}) scale(${this.zoom})`);
  }

  private renderDetails(root: HTMLElement): void {
    const node = this.graph.nodes.find((item) => item.path === this.selectedPath);
    if (!node) return;
    const details = root.createDiv({ cls: "skill-tree-details" });
    details.createEl("h3", { text: node.title });
    const status = details.createDiv({ cls: `skill-tree-status status-${node.status}` });
    status.createEl("span", { text: statusSymbol(node.status), attr: { "aria-hidden": "true" } });
    status.createEl("strong", { text: statusLabel(node.status) });
    if (node.status === "gray") {
      details.createEl("p", { text: node.attempted ? "Quiz attempted; a perfect completed attempt is still required." : "Pass every quiz question correctly in one attempt to reach Understood." });
    } else {
      details.createEl("p", { text: `${node.mature_cards}/${node.total_cards} flashcards mature.` });
      if (node.total_cards === 0) details.createEl("p", { text: "At least one associated flashcard is required to reach Learned." });
      else if (node.unknown_cards > 0) details.createEl("p", { text: `${node.unknown_cards} card schedule${node.unknown_cards === 1 ? " is" : "s are"} unknown; check the diagnostic below.` });
      else if (node.status === "understood") details.createEl("p", { text: "All cards need a scheduled interval of at least 32 days to reach Learned." });
    }
    const buttons = details.createDiv({ cls: "skill-tree-actions" });
    const open = buttons.createEl("button", { text: "Open lesson" });
    open.addEventListener("click", () => void this.onOpenNote(node.path));
    const quiz = buttons.createEl("button", { text: "Start quiz", cls: "mod-cta" });
    quiz.disabled = !node.id;
    quiz.addEventListener("click", () => void this.onStartQuiz(node));
    if (node.diagnostics.length > 0) {
      const diagnostics = details.createDiv({ cls: "skill-tree-node-diagnostics" });
      diagnostics.createEl("h4", { text: "Lesson diagnostics" });
      const list = diagnostics.createEl("ul");
      for (const item of node.diagnostics) list.createEl("li", { text: item.message });
    }
  }

  private renderDiagnostics(root: HTMLElement): void {
    if (this.graph.diagnostics.length === 0) return;
    const container = root.createDiv({ cls: "skill-tree-diagnostics" });
    container.createEl("h3", { text: "Diagnostics" });
    const list = container.createEl("ul");
    for (const item of this.graph.diagnostics) list.createEl("li", { text: diagnosticText(item) });
  }
}

class QuizModal extends Modal {
  private node: SkillNode;
  private rawQuiz: string;
  private fingerprint: string;
  private onFinished: (id: string, fingerprint: string, passed: boolean) => Promise<void>;
  private answered = new Map<string, string>();
  private submitted = false;
  private message: string | null = null;

  constructor(
    app: App,
    node: SkillNode,
    rawQuiz: string,
    fingerprint: string,
    onFinished: (id: string, fingerprint: string, passed: boolean) => Promise<void>,
  ) {
    super(app);
    this.node = node;
    this.rawQuiz = rawQuiz;
    this.fingerprint = fingerprint;
    this.onFinished = onFinished;
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const content = this.contentEl;
    content.empty();
    content.addClass("skill-tree-quiz-modal");
    const quiz = JSON.parse(public_quiz_json(this.rawQuiz)) as PublicQuiz;
    content.createEl("h2", { text: `${this.node.title} quiz` });
    content.createEl("p", { text: "Complete every question. Only a perfect attempt passes." });
    const form = content.createEl("form", { cls: "skill-tree-quiz-form" });
    quiz.questions.forEach((question, index) => {
      const fieldset = form.createEl("fieldset", { cls: "skill-tree-question" });
      fieldset.createEl("legend", { text: `${index + 1}. ${question.prompt}` });
      for (const letter of ["A", "B", "C", "D"] as const) {
        const label = fieldset.createEl("label", { cls: "skill-tree-choice" });
        const input = label.createEl("input", { attr: { type: "radio", name: question.id, value: letter } });
        input.checked = this.answered.get(question.id) === letter;
        input.addEventListener("change", () => {
          this.answered.set(question.id, letter);
          this.message = null;
        });
        label.createEl("span", { text: `${letter}. ${question.choices[letter]}` });
      }
    });
    const result = content.createDiv({ cls: "skill-tree-quiz-result" });
    if (this.submitted) {
      const grade = JSON.parse(grade_quiz_json(this.rawQuiz, JSON.stringify(Object.fromEntries(this.answered)))) as GradeResult;
      result.createEl("p", { text: grade.perfect ? "Perfect attempt. This lesson is now Understood." : `${grade.correct}/${grade.total} correct. A perfect attempt is required; your answers were not revealed.` });
    } else if (this.message) {
      result.createEl("p", { text: this.message });
    }
    const actions = content.createDiv({ cls: "skill-tree-actions" });
    const submit = actions.createEl("button", { text: this.submitted ? "Try again" : "Submit quiz", cls: "mod-cta" });
    submit.type = "button";
    submit.addEventListener("click", async () => {
      if (this.submitted) {
        this.submitted = false;
        this.message = null;
        this.answered.clear();
        this.render();
        return;
      }
      const grade = JSON.parse(grade_quiz_json(this.rawQuiz, JSON.stringify(Object.fromEntries(this.answered)))) as GradeResult;
      if (!grade.complete) {
        this.message = `Answer every question before submitting (${grade.answered}/${grade.total} answered).`;
        this.render();
        return;
      }
      await this.onFinished(this.node.id, this.fingerprint, grade.perfect);
      this.submitted = true;
      this.render();
    });
    const close = actions.createEl("button", { text: "Close" });
    close.type = "button";
    close.addEventListener("click", () => this.close());
  }
}

export default class SkillTreePlugin extends Plugin {
  private storage: StoredData = { passes: {}, attempts: {} };
  private refreshTimer: number | null = null;
  private refreshInProgress = false;
  private refreshQueued = false;
  private ready = false;

  async onload(): Promise<void> {
    try {
      await initWasm({ module_or_path: wasmBinary });
    } catch (error) {
      new Notice(`Skill Tree could not start its learning engine: ${String(error)}`);
      return;
    }
    this.storage = getStoredData(await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new SkillTreeView(leaf, (path) => this.openLesson(path), (node) => this.startQuiz(node)));
    this.addRibbonIcon("git-branch", "Open skill tree", () => void this.openTree());
    this.addCommand({ id: "open-skill-tree", name: "Open skill tree", callback: () => void this.openTree() });
    this.registerEvent(this.app.vault.on("modify", (file) => this.changed(file)));
    this.registerEvent(this.app.vault.on("create", (file) => this.changed(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.changed(file)));
    this.registerEvent(this.app.vault.on("rename", (file) => this.changed(file)));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.changed(file)));
    this.app.workspace.onLayoutReady(() => {
      this.ready = true;
      void this.refreshGraph();
    });
  }

  onunload(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  private changed(file: TFile | unknown): void {
    if (file instanceof TFile && !file.path.endsWith(".md") && !file.path.endsWith(".json")) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshGraph();
    }, 250);
  }

  private async openTree(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    if (this.ready) await this.refreshGraph();
  }

  private async openLesson(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`Lesson note not found: ${path}`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async startQuiz(node: SkillNode): Promise<void> {
    const lesson = this.app.vault.getAbstractFileByPath(node.path);
    if (!(lesson instanceof TFile)) {
      new Notice(`Lesson note not found: ${node.path}`);
      return;
    }
    const metadata = this.app.metadataCache.getFileCache(lesson)?.frontmatter;
    const quizPath = frontmatterString(metadata?.["skill-quiz"]);
    if (!quizPath) {
      new Notice("Add a skill-quiz path to this lesson's frontmatter.");
      return;
    }
    const quizFile = this.app.vault.getAbstractFileByPath(quizPath);
    if (!(quizFile instanceof TFile) || quizFile.extension.toLowerCase() !== "json") {
      new Notice(`Quiz file not found: ${quizPath}`);
      return;
    }
    try {
      const rawQuiz = await this.app.vault.read(quizFile);
      const fingerprint = quiz_fingerprint(rawQuiz);
      new QuizModal(this.app, node, rawQuiz, fingerprint, (id, currentFingerprint, passed) => this.saveAttempt(id, currentFingerprint, passed)).open();
    } catch (error) {
      new Notice(`Quiz could not be loaded: ${String(error)}`);
    }
  }

  private async saveAttempt(id: string, fingerprint: string, passed: boolean): Promise<void> {
    this.storage.attempts[id] = new Date().toISOString();
    if (passed) this.storage.passes[id] = fingerprint;
    await this.saveData(this.storage);
    await this.refreshGraph();
  }

  private async collectLessons(): Promise<LessonInput[]> {
    const lessons: LessonInput[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!isSkillCandidate(frontmatter)) continue;
      const markdown = await this.app.vault.cachedRead(file);
      const id = frontmatterString(frontmatter?.["skill-id"]) ?? "";
      const quizPath = frontmatterString(frontmatter?.["skill-quiz"]);
      let quiz: unknown | null = null;
      let quizError: string | null = null;
      if (!quizPath) {
        quizError = "Add a skill-quiz path to this lesson's frontmatter.";
      } else {
        const quizFile = this.app.vault.getAbstractFileByPath(quizPath);
        if (!(quizFile instanceof TFile) || quizFile.extension.toLowerCase() !== "json") {
          quizError = `Quiz file not found: ${quizPath}`;
        } else {
          try {
            const rawQuiz = await this.app.vault.cachedRead(quizFile);
            quiz = JSON.parse(rawQuiz);
            quiz_fingerprint(rawQuiz);
          } catch (error) {
            quiz = null;
            quizError = `Quiz is invalid: ${String(error)}`;
          }
        }
      }
      const inDeck = isSpacedRepetitionDeck(markdown, frontmatter);
      lessons.push({
        id,
        path: file.path,
        title: fileTitle(file),
        parents: frontmatterParents(frontmatter?.["skill-parents"]),
        quiz,
        quiz_error: quizError,
        passed_fingerprint: id ? this.storage.passes[id] ?? null : null,
        attempted: id ? Boolean(this.storage.attempts[id]) : false,
        cards: readCardMaturities(markdown, inDeck),
      });
    }
    return lessons;
  }

  private async refreshGraph(): Promise<void> {
    if (!this.ready) return;
    if (this.refreshInProgress) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInProgress = true;
    try {
      do {
        this.refreshQueued = false;
        const graph = JSON.parse(analyze_graph_json(JSON.stringify(await this.collectLessons()))) as GraphResult;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
          (leaf.view as SkillTreeView).setGraph(graph);
        }
      } while (this.refreshQueued);
    } catch (error) {
      console.error("Skill Tree refresh failed", error);
      new Notice(`Skill Tree could not refresh: ${String(error)}`);
    } finally {
      this.refreshInProgress = false;
    }
  }
}


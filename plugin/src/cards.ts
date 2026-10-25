export type CardMaturity = "mature" | "immature" | "unknown";

export const UPSTREAM_MATURE_INTERVAL_DAYS = 32;

interface CardGroup {
  text: string;
  count: number;
}

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const closing = normalized.indexOf("\n---", 4);
  return closing < 0 ? normalized : normalized.slice(closing + 4);
}

export function isSpacedRepetitionDeck(
  markdown: string,
  frontmatter: Record<string, unknown> | undefined,
): boolean {
  const tags = frontmatter?.tags;
  const candidates = Array.isArray(tags) ? tags : typeof tags === "string" ? [tags] : [];
  if (candidates.some((tag) => typeof tag === "string" && isFlashcardTag(tag))) return true;
  return /(^|\s)#flashcards(?:\/[\w/-]+)?(?=\s|$)/m.test(stripFrontmatter(markdown));
}

function isFlashcardTag(tag: string): boolean {
  const normalized = tag.trim().replace(/^#/, "");
  return normalized === "flashcards" || normalized.startsWith("flashcards/");
}

function inlineCodeContains(line: string, index: number): boolean {
  const before = line.slice(0, index).match(/`/g)?.length ?? 0;
  const after = line.slice(index).match(/`/g)?.length ?? 0;
  return before % 2 === 1 && after % 2 === 1;
}

function findInlineSeparator(line: string): { index: number; count: number } | null {
  for (const separator of [":::", "::"]) {
    let index = line.indexOf(separator);
    while (index >= 0) {
      if (!inlineCodeContains(line, index)) {
        const left = line.slice(0, index).trim();
        const right = line.slice(index + separator.length).trim();
        if (left && right) return { index, count: separator === ":::" ? 2 : 1 };
      }
      index = line.indexOf(separator, index + separator.length);
    }
  }
  return null;
}

function clozeCount(text: string): number {
  const expression = /==([^=\n]+)==(?:\^\[[^\]]*\])?(?:\[\^([\da-zA-Z]+)\])?/g;
  const unnumbered = new Set<number>();
  const numbered = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    if (inlineCodeContains(text, match.index)) continue;
    if (match[2]) numbered.add(match[2]);
    else unnumbered.add(match.index);
  }
  return numbered.size + unnumbered.size;
}

function withoutFencedCode(text: string): string {
  let fenceMarker: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      if (fenceMarker) {
        if (line.startsWith(fenceMarker)) fenceMarker = null;
        return line.trim() ? "CODE" : "";
      }
      if (line.startsWith("```") || line.startsWith("~~~")) {
        fenceMarker = line.startsWith("```") ? "```" : "~~~";
        return "CODE";
      }
      return line;
    })
    .join("\n");
}

function countMultiline(group: string): number {
  const visibleText = withoutFencedCode(group);
  const lines = visibleText.split("\n");
  const separator = lines.findIndex((line) => /^\s*\?\??\s*$/.test(line));
  if (separator >= 0) {
    const before = lines.slice(0, separator).join(" ").replace(/<[^>]*>/g, " ").trim();
    const after = lines
      .slice(separator + 1)
      .join(" ")
      .replace(/<!--SR:[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ")
      .trim();
    if (before && after) return lines[separator].includes("??") ? 2 : 1;
  }
  return clozeCount(visibleText);
}

function scheduleMetadataAt(
  lines: string[],
  startIndex: number,
): { text: string; endIndex: number } | null {
  if (startIndex >= lines.length) return null;
  const first = lines[startIndex].trim();
  const isComment = first.startsWith("<!--SR:");
  const isCallout = first.startsWith("> [!sr|card-metadata]");
  if (!isComment && !isCallout) return null;

  const collected = [lines[startIndex]];
  let index = startIndex;
  if (isComment) {
    while (!lines[index].includes("-->")) {
      index += 1;
      if (index >= lines.length) break;
      collected.push(lines[index]);
    }
  } else {
    let foundSchedule = lines[index].includes("<!--SR:");
    while (index + 1 < lines.length && lines[index + 1].trim().startsWith(">")) {
      index += 1;
      collected.push(lines[index]);
      foundSchedule ||= lines[index].includes("<!--SR:");
      if (foundSchedule && lines[index].includes("-->")) break;
    }
    if (foundSchedule && !lines[index].includes("-->")) {
      while (index + 1 < lines.length && !lines[index].includes("-->")) {
        index += 1;
        collected.push(lines[index]);
      }
    }
  }
  return { text: collected.join("\n"), endIndex: index };
}

function parseGroups(markdown: string): CardGroup[] {
  const lines = stripFrontmatter(markdown).split("\n");
  const result: CardGroup[] = [];
  let block: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flush = () => {
    if (block.length > 0) {
      const text = block.join("\n");
      const count = countMultiline(text);
      if (count > 0) result.push({ text, count });
      block = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (inFence) {
      block.push(line);
      if (line.startsWith(fenceMarker)) inFence = false;
      continue;
    }
    if (line.startsWith("```") || line.startsWith("~~~")) {
      block.push(line);
      inFence = true;
      fenceMarker = line.startsWith("```") ? "```" : "~~~";
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }

    const commentStart = line.indexOf("<!--");
    const scheduleOnly = trimmed.startsWith("<!--SR:") || trimmed.startsWith("> [!sr|card-metadata]");
    if (trimmed.startsWith("<!--") && !trimmed.startsWith("<!--SR:")) {
      if (!trimmed.includes("-->")) {
        while (index + 1 < lines.length && !lines[index].includes("-->")) index += 1;
      }
      continue;
    }
    if (scheduleOnly) {
      const metadata = scheduleMetadataAt(lines, index);
      if (metadata) {
        if (block.length > 0) block.push(metadata.text);
        else if (result.length > 0) result[result.length - 1].text += `\n${metadata.text}`;
        else block.push(metadata.text);
        index = metadata.endIndex;
      }
      continue;
    }

    const visibleLine = commentStart >= 0 ? line.slice(0, commentStart) : line;
    const inline = findInlineSeparator(visibleLine);
    if (inline) {
      flush();
      let text = line;
      const metadata = scheduleMetadataAt(lines, index + 1);
      if (metadata) {
        text += `\n${metadata.text}`;
        index = metadata.endIndex;
      }
      result.push({ text, count: inline.count });
      continue;
    }

    block.push(line);
  }
  flush();
  return result;
}

function scheduleMaturity(segment: string): CardMaturity {
  const fields = segment.replace(/^!/, "").split(",").map((field) => field.trim());
  if (fields[0] === "fsrs") {
    if (fields.length !== 10) return "unknown";
    const [, due, interval, stability, difficulty, state, reps, lapses, steps, lastReview] = fields;
    if (
      !Number.isFinite(Date.parse(due)) ||
      [interval, stability, difficulty, state, reps, lapses, steps].some(
        (value) => value.length === 0 || !Number.isFinite(Number(value)),
      ) ||
      Number(interval) < 0 ||
      Number(stability) < 0 ||
      !Number.isInteger(Number(state)) ||
      Number(state) < 0 ||
      Number(state) > 3 ||
      ![reps, lapses, steps].every((value) => Number.isInteger(Number(value)) && Number(value) >= 0) ||
      (lastReview !== "" && lastReview !== "null" && !Number.isFinite(Date.parse(lastReview)))
    ) {
      return "unknown";
    }
    return Number(interval) >= UPSTREAM_MATURE_INTERVAL_DAYS ? "mature" : "immature";
  }

  if (fields.length < 3 || fields.length > 4) return "unknown";
  const [due, interval, ease] = fields;
  const date = Date.parse(due);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(due) ||
    !Number.isFinite(date) ||
    interval.trim().length === 0 ||
    !Number.isFinite(Number(interval)) ||
    Number(interval) < 0 ||
    ease.trim().length === 0 ||
    !Number.isFinite(Number(ease)) ||
    Number(ease) < 0
  ) {
    return "unknown";
  }
  if (due === "2000-01-01") return "immature";
  return Number(interval) >= UPSTREAM_MATURE_INTERVAL_DAYS ? "mature" : "immature";
}

function schedulingForGroup(text: string, count: number): CardMaturity[] {
  const visibleText = withoutFencedCode(text);
  const comments = [...visibleText.matchAll(/<!--SR:([\s\S]*?)-->/g)].map((match) => match[1]);
  if (comments.length === 0) {
    return visibleText.includes("<!--SR:") ? Array(count).fill("unknown") : Array(count).fill("immature");
  }

  const schedules = comments.flatMap((comment) => {
    const parts = comment.split("!").filter((part) => part.trim().length > 0);
    return parts.length > 0 ? parts.map(scheduleMaturity) : ["unknown" as const];
  });
  while (schedules.length < count) schedules.push("immature");
  return schedules.slice(0, count);
}

export function readCardMaturities(markdown: string, inDeck: boolean): CardMaturity[] {
  if (!inDeck) return [];
  return parseGroups(markdown).flatMap((group) => schedulingForGroup(group.text, group.count));
}

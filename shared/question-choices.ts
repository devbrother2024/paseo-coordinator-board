// A question such as "Shall I go with (b)?" only makes sense next to what (b) is.
// These helpers find the option labels a question points to, the lines that define them,
// and the text that came right before the question, so the card can stand on its own.

export type LabelKind = "latin" | "hangul" | "number";
/** How the text points at a label: "(b)", "B안", "Option B", "B로" or "2번". */
export type ReferenceForm = "paren" | "plan" | "option" | "bare" | "number";
/** How a line defines a label: "(b) …", "b) …", "B. …" or "1. …", "B안: …", "Option B: …", "**B**: …". */
export type DefinitionForm = "paren" | "close" | "dot" | "plan" | "option" | "bold";
export type LabelReference = { key: string; kind: LabelKind; paren: boolean; form: ReferenceForm };
export type LabelDefinition = { key: string; markdown: string; form?: DefinitionForm };
export type Choice = { label: string; markdown: string };
export type ChoiceGaps = { missingLabels: string[]; deferred: boolean };

/** Marks a pick-one question whose other options were never mentioned anywhere. */
export const OTHER_CHOICES = "다른 선택지";
export const MAX_LABELS = 8;
export const MAX_DEFINITION = 600;
export const CONTEXT_LIMIT = 1500;

const hangul = "가나다라마바사아";
const kindOf = (key: string): LabelKind => /[1-9]/.test(key) ? "number" : hangul.includes(key) ? "hangul" : "latin";
const normalize = (raw: string) => /[A-Za-z]/.test(raw) ? raw.toLowerCase() : raw;
const order = (key: string) => kindOf(key) === "hangul" ? hangul.indexOf(key) : key.charCodeAt(0);

function withoutCode(text: string) {
  return text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\s*\1[^\n]*$|(?![\s\S]))/gm, "").replace(/`[^`\n]*`/g, "");
}

// A particle written right after the label, as in "B로", "B안이" or "**B**를". A space breaks it: "B 요청을" is not a label.
const particle = String.raw`(?:으로|로|를|을|가|와|과|는|은|쪽|이요|요(?=[?？.!\s]|$)|이(?=\s))`;
// "B안" is a plan only when 안 ends the word or takes a particle. "B안전", "A안에서" are other words.
const planEnd = String.raw`(?=$|[^가-힣]|(?:으로|은|는|이|을|를|과|와|대로|도|쪽|이요|요)(?![가-힣]))`;
const referencePatterns: { pattern: RegExp; form: ReferenceForm }[] = [
  // "(c) 2026" is a copyright mark.
  { pattern: /\(([A-Ha-h가나다라마바사아])\)(?!\s*(?:19|20)\d\d)/g, form: "paren" },
  // "(1)" is often plain numbering inside a sentence. It points at an option only with a particle, as in "(2)로".
  { pattern: new RegExp(String.raw`\(([1-9])\)(?=\s?${particle})`, "g"), form: "paren" },
  { pattern: new RegExp(String.raw`(?<![A-Za-z0-9가-힣])([A-H1-9가나다라])안${planEnd}`, "g"), form: "plan" },
  { pattern: /(?:옵션|선택지)\s*([A-H1-9])(?![A-Za-z0-9])/g, form: "option" },
  { pattern: /\b(?:[Oo]ption|[Cc]hoice|[Pp]lan)\s+([A-H1-9])(?![A-Za-z0-9])/g, form: "option" },
  // "C로 작성" names the C language.
  { pattern: new RegExp(String.raw`(?<![A-Za-z0-9_./#-])(?<![A-Za-z0-9*]\*\*)(?<!\*[A-Za-z0-9])(?!C(?:\*\*|__)?(?:으로|로)\s*(?:작성|구현|짜|만들|컴파일|포팅))([A-H])(?=(?:\*\*|__)?${particle})`, "g"), form: "bare" },
  { pattern: /(?<![A-Za-z0-9])([1-9])\s?번\s?(?:안|으로|을|를|쪽)/g, form: "number" },
  { pattern: /\b(?:with|choose|pick|prefer|go for|take)\s+([A-H])(?=\s*(?:[?.!,)]|$|or\b|and\b|instead\b))/g, form: "bare" },
];

type Mention = LabelReference & { at: number };
const hangulPlan = (item: Pick<LabelReference, "kind" | "form">) => item.kind === "hangul" && item.form === "plan";

function mentions(text: string, withHangulPlans: boolean) {
  const plain = withoutCode(text);
  const found: Mention[] = [];
  for (const { pattern, form } of referencePatterns) {
    for (const match of plain.matchAll(pattern)) {
      const key = normalize(match[1]);
      if (!withHangulPlans && hangulPlan({ kind: kindOf(key), form })) continue;
      const at = match.index ?? 0;
      const paren = form === "paren";
      const prior = found.find(item => item.key === key);
      if (!prior) found.push({ key, kind: kindOf(key), paren, form, at });
      else if (at < prior.at) Object.assign(prior, { at, paren, form });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * Labels in the order the text mentions them, without duplicates. Korean "가안" also means "a draft", so it counts
 * only with `withHangulPlans`, for a caller that checks a "가안: …" line defines it.
 */
export function referencedLabels(text: string, withHangulPlans = false): LabelReference[] {
  return mentions(text, withHangulPlans).slice(0, MAX_LABELS).map(({ at: _at, ...item }) => item);
}

/** True when a line opens by pointing at a label other than `key`, as in "(a)를 추천합니다". */
function opensWithOtherLabel(line: string, key: string) {
  const head = line.trim().replace(/^>\s*/, "").replace(/^[-*+]\s+/, "");
  return mentions(head, false).some(item => item.at <= 2 && item.key !== key);
}

// Case-sensitive: "Plan a release" and "a. …" do not define a label. Korean labels only as "(가)", "가)", "가." or "가안".
const markers: { pattern: RegExp; form: DefinitionForm }[] = [
  { pattern: /^\(([A-Ha-h가나다라마바사아1-9])\)/, form: "paren" },
  { pattern: /^([A-Ha-h가나다라마바사아1-9])\)/, form: "close" },
  { pattern: /^([A-Ha-h1-9가나다라마바사아])[.:：](?=\s|\*\*|__)/, form: "dot" },
  { pattern: /^([A-H1-9])\s?안(?:은|는)?/, form: "plan" },
  // "가안 검토를 마쳤습니다" talks about a draft. A Korean plan label needs a separator: "가안: …", "**나안** - …".
  { pattern: /^([가나다라])안(?=(?:\*\*|__)?\s*[:：.)\-–—])/, form: "plan" },
  { pattern: /^(?:옵션|선택지|[Oo]ption|[Cc]hoice|[Pp]lan)\s*([A-H1-9])(?![A-Za-z0-9])/, form: "option" },
];

/** The label a line defines and how, when the line starts with one, such as "(a) …", "B안: …" or "- **Option C** …". */
export function definitionMarker(line: string): { key: string; form: DefinitionForm } | null {
  const trimmed = line.trim().replace(/^>\s*/, "").replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "");
  const bold = /^(?:\*\*|__)/.test(trimmed);
  const head = trimmed.replace(/^(?:\*\*|__)/, "");
  for (const { pattern, form } of markers) {
    const match = pattern.exec(head);
    if (match) return separated(head.slice(match[0].length)) ? { key: normalize(match[1]), form } : null;
  }
  // "**A**: …" or "**A** …" names the label in bold by itself.
  const alone = bold ? /^([A-H1-9])(?=\*\*|__)/.exec(head) : null;
  return alone && separated(head.slice(1)) ? { key: normalize(alone[1]), form: "bold" } : null;
}

// "(b)로 진행할까요?" points at a label. A definition is followed by a separator, not a particle.
const separated = (rest: string) => !rest || /^(?:\*\*|__)?(?:\s|[:：.)\-–—]|$)/.test(rest);

/** The label a line defines, when the line starts with one. */
export function definedLabel(line: string): string | null {
  return definitionMarker(line)?.key ?? null;
}

function clip(text: string, limit: number) {
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
}

function isHeading(line: string) {
  return /^\s*#{1,6}\s/.test(line);
}

const asks = (line: string) => /[?？](?:\*\*|__)?\s*$/.test(line.trim());

/** Every label defined in a text with its Markdown, in the order the text defines them. */
export function labelDefinitions(text: string): LabelDefinition[] {
  const lines = text.split(/\r?\n/);
  const fenced: boolean[] = [];
  let inside: string | null = null;
  for (const line of lines) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (inside) { fenced.push(true); if (fence && fence[0] === inside[0] && fence.length >= inside.length) inside = null; continue; }
    if (fence) { inside = fence; fenced.push(true); continue; }
    fenced.push(false);
  }
  const definitions: LabelDefinition[] = [];
  for (let i = 0; i < lines.length && definitions.length < MAX_LABELS * 3; i++) {
    const found = !fenced[i] ? definitionMarker(lines[i]) : null;
    if (!found || definitions.some(item => item.key === found.key && item.form === found.form)) continue;
    const { key, form } = found;
    const block = [lines[i].trim()];
    let j = i + 1;
    // A definition stops at the next definition, a heading or a question. "(a)보다 느리지만" inside it stays.
    const stop = (index: number) => index >= lines.length || (!fenced[index] && (definitionMarker(lines[index]) !== null ||
      isHeading(lines[index]) || asks(lines[index])));
    while (!stop(j) && lines[j].trim()) block.push(lines[j++].trimEnd());
    // A short title line such as "**(b) Register the host once**" carries its explanation in the next paragraph.
    if (block.length === 1 && block[0].length <= 100 && !/[.。!?？]$/.test(block[0].replace(/\*+$/, ""))) {
      let k = j;
      while (k < lines.length && !lines[k].trim()) k++;
      // A paragraph that opens with another label, such as "(a)를 추천합니다", is about that label.
      if (!stop(k) && !opensWithOtherLabel(lines[k], key)) { block.push(""); j = k; }
      while (!stop(j) && lines[j].trim()) block.push(lines[j++].trimEnd());
    }
    definitions.push({ key, form, markdown: clip(block.join("\n").trim(), MAX_DEFINITION) });
  }
  return definitions;
}

// Which definitions answer a reference, best first. "1안" is not item 1 of a numbered list.
const preferred: Record<ReferenceForm, DefinitionForm[]> = {
  paren: ["paren", "close", "plan", "option", "bold", "dot"],
  plan: ["plan", "option", "paren", "close", "bold", "dot"],
  option: ["option", "plan", "paren", "close", "bold", "dot"],
  bare: ["paren", "close", "plan", "option", "bold", "dot"],
  number: ["dot", "close", "paren", "plan", "option", "bold"],
};
function rank(key: string, reference: ReferenceForm, form: DefinitionForm = "paren") {
  if (form === "dot" && kindOf(key) === "number" && (reference === "plan" || reference === "option")) return -1;
  return preferred[reference].indexOf(form);
}

/** The best definition of `key` for the way the question points at it. */
export function bestDefinition(definitions: readonly LabelDefinition[], key: string, reference: ReferenceForm) {
  let best: LabelDefinition | undefined;
  for (const item of definitions) {
    if (item.key !== key) continue;
    const score = rank(key, reference, item.form);
    if (score >= 0 && (!best || score < rank(key, reference, best.form))) best = item;
  }
  return best;
}

/** Up to about `limit` characters of whole paragraphs right before the question. Code blocks are kept whole or left out. */
export function contextBefore(lines: readonly string[], limit = CONTEXT_LIMIT) {
  const blocks: { text: string; code: boolean }[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let fence = "";
  const flush = () => { if (paragraph.length) blocks.push({ text: paragraph.join("\n"), code: false }); paragraph = []; };
  for (const line of lines) {
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (code) {
      code.push(line);
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) { blocks.push({ text: code.join("\n"), code: true }); code = null; }
      continue;
    }
    if (opener) { flush(); code = [line]; fence = opener; continue; }
    if (!line.trim()) flush(); else paragraph.push(line.trimEnd());
  }
  flush();
  // An unclosed fence at the end is a partial code block. Leave it out.
  const kept: string[] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const cost = block.text.length + (kept.length ? 2 : 0);
    if (used + cost <= limit) { kept.unshift(block.text); used += cost; continue; }
    if (!kept.length && !block.code) {
      // A single long paragraph: keep its end, starting at a line or sentence boundary.
      const tail = block.text.slice(-(limit - 1));
      const start = tail.search(/\n|(?<=[.!?。？])\s/);
      kept.unshift("…" + (start > 0 && start < tail.length / 2 ? tail.slice(start).trimStart() : tail));
    }
    break;
  }
  return kept.join("\n\n").trim();
}

export type ChoiceSource = { text: string; definitions?: readonly LabelDefinition[] };

function definitionIn(source: ChoiceSource, key: string, reference: ReferenceForm) {
  return (bestDefinition(source.definitions ?? [], key, reference) ?? bestDefinition(labelDefinitions(source.text), key, reference))?.markdown;
}

function labelsIn(source: ChoiceSource, kind: LabelKind, reference: ReferenceForm) {
  const defined = [...labelDefinitions(source.text), ...(source.definitions ?? [])]
    .filter(item => rank(item.key, reference, item.form) >= 0).map(item => item.key);
  return [...referencedLabels(source.text).map(item => item.key), ...defined].filter(key => kindOf(key) === kind);
}

function definedAsPlan(source: ChoiceSource, key: string) {
  return [...(source.definitions ?? []), ...labelDefinitions(source.text)].some(item => item.key === key && item.form === "plan");
}

export function displayLabel(key: string, paren: boolean) {
  const shown = kindOf(key) === "latin" && !paren ? key.toUpperCase() : key;
  return paren ? `(${shown})` : shown;
}

/**
 * The options a question points to and the ones nobody defined.
 * `message` is the last assistant message, `context` its text before the question and `earlier` the
 * earlier assistant turns, newest first.
 */
export function questionChoices(input: { question: string; context: string; message: ChoiceSource; earlier: readonly ChoiceSource[] }) {
  const sources = [input.message, ...input.earlier];
  const references = referencedLabels(input.question, true)
    .filter(item => !hangulPlan(item) || sources.some(source => definedAsPlan(source, item.key)));
  if (!references.length) return { choices: [] as Choice[], missingLabels: [] as string[] };
  const style = references[0].paren;
  const forms = new Map(references.map(item => [item.key, item.form]));
  const wanted = references.map(item => item.key);
  // "Shall I go with (b)?" asks the person to pick one, so the other options of the same kind belong on the card.
  const pickOne = references.length === 1;
  if (pickOne) {
    const kind = references[0].kind;
    for (const source of [{ text: input.context }, input.message, ...input.earlier]) {
      for (const key of labelsIn(source, kind, references[0].form)) if (!wanted.includes(key)) wanted.push(key);
    }
  }
  const keys = wanted.slice(0, MAX_LABELS).sort((a, b) => order(a) - order(b));
  const choices: Choice[] = [];
  const missingLabels: string[] = [];
  for (const key of keys) {
    let markdown: string | undefined;
    for (const source of [input.message, ...input.earlier]) {
      markdown = definitionIn(source, key, forms.get(key) ?? references[0].form);
      if (markdown) break;
    }
    if (markdown) choices.push({ label: displayLabel(key, style), markdown });
    else missingLabels.push(displayLabel(key, style));
  }
  if (pickOne && keys.length === 1) missingLabels.push(OTHER_CHOICES);
  return { choices, missingLabels };
}

// Only words that send the reader elsewhere: "세션 화면 참고", "직전 글에 있음", "자세한 건 세션에서". Evidence such as
// "세션 기록에서 확인한 결과" or "앞 글에 설명한 대로" does not.
const deferral = new RegExp([
  String.raw`(?:세션|작업\s*세션|원래\s*세션)\s*(?:화면|기록|대화)(?:을|를)?\s*(?:참고|참조|보세요|봐\s*주세요)`,
  String.raw`(?:직전|이전|앞|위)\s*(?:의\s*)?(?:글|메시지|답변|대화)(?:을|를)?\s*(?:참고|참조|보세요|봐\s*주세요)`,
  String.raw`(?:직전|이전|앞|위)\s*(?:의\s*)?(?:글|메시지|답변|대화)에\s*(?:있음|있습니다)(?=[.\s]|$)`,
  String.raw`자세한\s*(?:건|것은|내용은)\s*(?:담당\s*|작업\s*|원래\s*)?세션`,
  String.raw`자세한\s*(?:건|것은|내용은)[^.\n]{0,30}(?:에\s*(?:있음|있습니다)(?=[.\s]|$)|참고|참조|보세요)`,
  String.raw`설명은\s*(?:담당\s*|작업\s*|원래\s*)?세션(?:\s*(?:화면|기록|대화))?에\s*(?:있음|있습니다)`,
  String.raw`\b(?:see|refer to)\s+(?:the\s+)?(?:session|previous message|earlier message|last message)\b`,
  String.raw`\bcheck\s+(?:the\s+)?(?:session|previous message|earlier message|last message)\s+for\s+(?:details|more)\b`,
  String.raw`\bdetails? (?:are|is) in the (?:session|previous message)\b`,
].join("|"), "i");

/** True when a card sends the reader back to the session for the explanation. */
export const defersToSession = (text: string) => deferral.test(text);

function keysOfOption(label: string) {
  const own = definedLabel(label);
  const keys = new Set(referencedLabels(label).map(item => item.key));
  if (own) keys.add(own);
  const bare = label.trim().replace(/^\(|\)$/g, "");
  if (/^[A-Ha-h1-9가나다라마바사아]$/.test(bare)) keys.add(normalize(bare));
  return keys;
}

/** Labels a card names without saying what they are. `options` are the labels or keys the card itself carries. */
export function cardChoiceGaps(texts: readonly (string | undefined | null)[], options: readonly string[], definitionTexts: readonly (string | undefined | null)[] = []): ChoiceGaps {
  const written = texts.filter((text): text is string => !!text);
  const references = referencedLabels(written.join("\n"));
  const known = new Set<string>();
  for (const option of options) for (const key of keysOfOption(option)) known.add(key);
  const definitions = [...written, ...definitionTexts.filter((text): text is string => !!text)].flatMap(labelDefinitions);
  const style = references[0]?.paren ?? false;
  return {
    missingLabels: references.filter(item => !known.has(item.key) && !bestDefinition(definitions, item.key, item.form))
      .map(item => displayLabel(item.key, style)),
    deferred: written.some(defersToSession),
  };
}

function subject(labels: readonly string[]) {
  const named = labels.filter(label => label !== OTHER_CHOICES);
  const other = labels.includes(OTHER_CHOICES);
  return {
    ko: [...named, ...(other ? ["다른 선택지"] : [])].join(", "),
    en: [...named, ...(other ? ["the other options"] : [])].join(", "),
    // Korean particle after the last word: 이 after a final consonant (1, 3, 6, 7, 8), otherwise 가.
    particle: !other && /[13678]\)?$/.test(named.at(-1) ?? "") ? "이" : "가",
  };
}

export type Bilingual = [ko: string, en: string];

/** The notice a card shows when it names options it does not explain. */
export function missingChoicesNotice(labels: readonly string[], where: "session" | "card"): Bilingual {
  const named = labels.filter(label => label !== OTHER_CHOICES);
  const parts: Bilingual[] = [];
  if (named.length) {
    const { ko, en, particle } = subject(named);
    parts.push(where === "session"
      ? [`이 질문의 ${ko}${particle} 무엇인지 세션 기록에서 찾지 못했습니다.`, `Could not find what ${en} ${named.length > 1 ? "are" : "is"} in the session history.`]
      : [`이 카드는 ${ko}${particle} 무엇인지 설명하지 않습니다.`, `This card does not explain what ${en} ${named.length > 1 ? "are" : "is"}.`]);
  }
  if (labels.includes(OTHER_CHOICES)) parts.push(where === "session"
    ? ["이 질문에서 고를 수 있는 다른 선택지를 세션 기록에서 찾지 못했습니다.", "Could not find the other options for this question in the session history."]
    : ["이 카드에는 고를 수 있는 다른 선택지가 없습니다.", "This card does not list the other options."]);
  return [parts.map(part => part[0]).join(" "), parts.map(part => part[1]).join(" ")];
}

export const deferredNotice: Bilingual = [
  "이 카드는 설명을 세션 화면으로 미룹니다. 보드만 보고 정할 수 있게 보완을 요청하세요.",
  "This card sends you to the session for the explanation. Ask for the card to be completed so you can decide here.",
];

/** The question a person can send to the work session to have every option explained in one message. */
export function choiceExplanationRequest(labels: readonly string[]): Bilingual {
  if (!labels.length) return [
    "이 결정에 필요한 설명(선택지마다 무엇이고 고르면 무엇이 달라지는지, 장단점과 추천 이유)을 한 메시지로 정리해 주세요.",
    "In one message, please explain this decision: each option, what changes with each choice, their pros and cons, and which you recommend and why.",
  ];
  const { ko, en, particle } = subject(labels);
  return [
    `선택지 ${ko}${particle} 각각 무엇이고, 고르면 무엇이 달라지는지, 장단점과 추천 이유를 한 메시지로 정리해 주세요.`,
    `In one message, please explain what options ${en} each are, what changes with each choice, their pros and cons, and which you recommend and why.`,
  ];
}

/** The request a person can send to the coordinator to complete a card that names options it does not explain. */
export function cardCompletionRequest(labels: readonly string[], deferred: boolean): Bilingual {
  const { ko, en } = subject(labels);
  const what: Bilingual = labels.length
    ? [`이 카드가 가리키는 선택지 ${ko}의 설명이 카드에 없습니다.`, `This card names options ${en} without explaining them.`]
    : ["이 카드가 설명을 세션 화면으로 미루고 있습니다.", "This card sends the reader to the session for the explanation."];
  return [
    `${deferred && labels.length ? "카드가 설명을 세션 화면으로 미루고 있고, " : ""}${what[0]} 모든 선택지가 무엇이고 고르면 무엇이 달라지는지, 장단점을 카드의 선택지(questions[].options의 does, pros, cons, 또는 content.options)로 옮겨 보드만 보고 정할 수 있게 해 주세요. 세션 기록에 다른 선택지 설명이 없으면 작업 세션에 먼저 정리를 요청해 주세요.`,
    `${deferred && labels.length ? "The card sends the reader to the session. " : ""}${what[1]} Put every option, what it does, and its pros and cons on the card (questions[].options with does, pros and cons, or content.options) so the decision can be made from the board alone. If the session history does not explain the other options, ask the work session to summarize them first.`,
  ];
}

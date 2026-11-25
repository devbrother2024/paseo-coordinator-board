// Which lines of a session's message ask the person to decide something.
const asking = /확인해\s*주실\s*것|(?:확인|선택|승인|결정|답변|지정)\s*(?:부탁드|해\s*(?:주세|주실|주셔야|주시겠))|(?:알려|골라|정해|답해)\s*(?:주세|주실|주셔야)|(?:할까요|될까요|하시겠어요|고르시겠어요|원하시나요)[?？]|\b(?:please (?:choose|confirm|approve)|which .* (?:prefer|choose)|shall I|would you like me to|could you (?:confirm|choose))\b/i;
// A heading that names the decision, or a line that says how to answer it. A quoted reply ("옮겨") is blanked to underscores by `unquoted`, so the guide forms look for the underscores.
const heading = /결정할\s*것\s*[:：]|(?:결정|답)이\s*필요(?:합니다|해요|한\s*것)|\bdecision needed\s*:|\bneeds your decision\b/i;
// English "reply" counts only as an instruction to the person: it opens the sentence, or follows please, just, simply or "you can". A statement with a subject ("The server will reply "OK"") describes something else.
const replyGuide = /_[*_\s]*라고\s*(?:하면|답하면|말씀하시면|보내면|해\s*주시면)\s*됩니다|(?:^[\s>*_\-+•]*|\b(?:please|just|simply|you\s+can)\s+)reply\s+(?:with\s+)?[*_]*_{2}|답을\s*받고\s*(?:바꾸|진행하|하)겠/iu;
const request = new RegExp(`${asking.source}|${heading.source}|${replyGuide.source}`, "iu");
const optionalOffer = /(?:궁금|필요|원하).{0,12}(?:시면|시다면|면).{0,25}(?:알려|말씀|도와)|\b(?:if you (?:like|want)|let me know if)\b|\bif\b.{0,40}\bneeds your decision\b/i;
const noQuestion = /(?:확인해\s*주실\s*것|결정해\s*주실\s*것|확인\s*요청)(?:은|이|이란)?\s*(?:없|없습니다|없음)|결정(?:할|이\s*필요한)?\s*것\s*(?:은|이)?\s*[:：]?\s*\**\s*없|\b(?:no decisions? (?:is |are )?(?:needed|required)|(?:nothing|none|nobody|no\s+one|no\s+\w+|not)\b.{0,20}\bneeds? your decision|decision needed\s*:\s*\**\s*(?:none|no|n\/a)\b)/i;
// A single quote opens only where a word does not continue into it, so "I've" and "it's" are not quotes.
// A double quote right after a digit is an inch mark (24"), not an opening quote.
const quoted = /“[^”\n]*”|(?<!\d)"[^"\n]*"|「[^」\n]*」|『[^』\n]*』|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]+'(?![A-Za-z0-9])/gu;

/** The line with quoted text blanked out, at the same length so positions still match the original. */
export function unquoted(line: string) {
  return line.replace(quoted, match => "_".repeat(match.length));
}

// A sentence ends at . ! ? 。 ！ ？ (and any closing mark after it) followed by a space. "3.5GB" and "v1.2" have no space after the dot, and "e.g." / "i.e." / "vs." do not end a sentence.
const sentenceEnd = /(?<!\be\.g\.|\bi\.e\.|\bvs\.)(?<=[.!?。！？][*_)\]」』”’]*)\s+/u;

/**
 * A line asks for a decision when one of its sentences, outside any quotes, makes the request.
 * A negation ("결정할 것은 없습니다") or an offer ("필요하면 알려 주세요") cancels only the sentence it is in, so a request in the next sentence still counts.
 * Line we hold: a fix here covers a request the check misses. A message that is not a question but still becomes a card is a known limit, and an example of one is not fixed one by one.
 * Known limit: a request that only the sentences before or after it can negate ("No decision is needed. If this changes, please choose a region.") is judged one sentence at a time.
 */
export function asksForDecision(line: string) {
  return unquoted(line).split(sentenceEnd).some(sentence => !noQuestion.test(sentence) && !optionalOffer.test(sentence) && request.test(sentence));
}

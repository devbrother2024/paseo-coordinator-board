// Which lines of a session's message ask the person to decide something.
const request = /확인해\s*주실\s*것|(?:확인|선택|승인|결정|답변|지정)\s*(?:부탁드|해\s*(?:주세|주실|주셔야|주시겠))|(?:알려|골라|정해|답해)\s*(?:주세|주실|주셔야)|(?:할까요|될까요|하시겠어요|고르시겠어요|원하시나요)[?？]|\b(?:please (?:choose|confirm|approve)|which .* (?:prefer|choose)|shall I|would you like me to|could you (?:confirm|choose))\b/i;
const optionalOffer = /(?:궁금|필요|원하).{0,12}(?:시면|시다면|면).{0,25}(?:알려|말씀|도와)|\b(?:if you (?:like|want)|let me know if)\b/i;
const noQuestion = /(?:확인해\s*주실\s*것|결정해\s*주실\s*것|확인\s*요청)(?:은|이|이란)?\s*(?:없|없습니다|없음)/;
// A single quote opens only where a word does not continue into it, so "I've" and "it's" are not quotes.
// A double quote right after a digit is an inch mark (24"), not an opening quote.
const quoted = /“[^”\n]*”|(?<!\d)"[^"\n]*"|「[^」\n]*」|『[^』\n]*』|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]+'(?![A-Za-z0-9])/gu;

/** The line with quoted text blanked out, at the same length so positions still match the original. */
export function unquoted(line: string) {
  return line.replace(quoted, match => "_".repeat(match.length));
}

/** A line asks for a decision when its own words, outside any quotes, make the request. */
export function asksForDecision(line: string) {
  const own = unquoted(line);
  return !noQuestion.test(own) && !optionalOffer.test(own) && request.test(own);
}

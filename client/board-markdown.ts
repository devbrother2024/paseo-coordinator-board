import { Lexer, Tokenizer } from "./vendor/marked/marked";

class BoardTokenizer extends Tokenizer {
  override del(source: string, maskedSource: string, previous?: string) {
    // Leave single tildes for the text tokenizer without changing the source of links or code.
    if (source.startsWith("~~")) return super.del(source, maskedSource, previous);
  }

  override fences(source: string) {
    const token = super.fences(source);
    // An unclosed opener is left to the paragraph rule, so its line reads as text.
    if (token && closedFence(token.raw)) return token;
  }
}

// A fence is a code block only when it is closed. An opener with no closer ("```)은 …" at the start of a wrapped line) would otherwise turn every paragraph and list after it into one code block.
export function closedFence(raw: string) {
  const lines = raw.trimEnd().split("\n");
  const opener = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])?.[1];
  const closer = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines.at(-1) ?? "")?.[1];
  return lines.length > 1 && !!opener && !!closer && closer[0] === opener[0] && closer.length >= opener.length;
}

export function lexBoardMarkdown(source: string) {
  return Lexer.lex(source, { gfm: true, breaks: true, tokenizer: new BoardTokenizer() });
}

export function lexBoardInline(source: string) {
  return Lexer.lexInline(source, { gfm: true, tokenizer: new BoardTokenizer() });
}

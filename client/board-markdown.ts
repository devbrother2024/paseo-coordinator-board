import { Lexer, Tokenizer } from "./vendor/marked/marked";

class BoardTokenizer extends Tokenizer {
  override del(source: string, maskedSource: string, previous?: string) {
    // Leave single tildes for the text tokenizer without changing the source of links or code.
    if (source.startsWith("~~")) return super.del(source, maskedSource, previous);
  }
}

export function lexBoardMarkdown(source: string) {
  return Lexer.lex(source, { gfm: true, breaks: true, tokenizer: new BoardTokenizer() });
}

export function lexBoardInline(source: string) {
  return Lexer.lexInline(source, { gfm: true, tokenizer: new BoardTokenizer() });
}

import type { Token, Tokens } from "./vendor/marked/marked";

// Match bare references and leave GitHub's owner/repository#number shorthand alone.
const reference = /(^|[^\w/#.-])(?:([\w.-]+\/[\w.-]+)[ \t]*)?#([1-9]\d*)(?![\w#])/g;
const plainText = (text: string): Tokens.Text => ({ type: "text", raw: text, text });

export function pullReferenceTokens(tokens: Token[], repository?: string): Token[] {
  if (!repository) return tokens;
  return tokens.flatMap(token => {
    if (token.type === "link" || token.type === "image") return [token];
    if ("tokens" in token && Array.isArray(token.tokens)) {
      return [{ ...token, tokens: pullReferenceTokens(token.tokens, repository) }];
    }
    if (token.type !== "text" || typeof token.text !== "string") return [token];
    const output: Token[] = [];
    let end = 0;
    for (const match of token.text.matchAll(reference)) {
      const [, prefix, qualifier, digits] = match;
      const number = Number(digits);
      if (qualifier || number > 2147483647) continue;
      const start = match.index + prefix.length;
      const text = "#" + digits;
      if (start > end) output.push(plainText(token.text.slice(end, start)));
      output.push({ type: "pullReference", raw: text, text, repo: repository, number });
      end = start + text.length;
    }
    if (!output.length) return [token];
    if (end < token.text.length) output.push(plainText(token.text.slice(end)));
    return output;
  });
}

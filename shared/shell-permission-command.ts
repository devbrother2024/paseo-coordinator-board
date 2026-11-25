// A display tokenizer for common shell syntax. Unrecognized syntax fails closed;
// no shell is invoked and source text remains available on the card.
export type ShellWord = { value: string; dynamic: boolean };
export type ShellCommand = {
  words: ShellWord[];
  redirects: ShellWord[];
  substitutions: ShellCommand[][];
};

const separator = /(?:&&|\|\||\|&|[;&|\n])/y;
const redirect = /(?:&>>?|\d*(?:<<<|<<-|<<|<>|>>|>\||>&|<&|>|<))/y;
const sizeLimit = 32_000;

function at(pattern: RegExp, source: string, index: number) {
  pattern.lastIndex = index;
  return pattern.exec(source)?.[0];
}

export function shellCommands(source: string): ShellCommand[] | null {
  if (source.length > sizeLimit) return null;
  let index = 0;
  const character = () => source[index];
  const next = () => source[index++];
  const invalid = () => { throw Error("Unsupported shell syntax"); };

  function substitution(depth: number): ShellCommand[] {
    if (next() === "$") {
      next(); // (
      return sequence(depth + 1, true);
    }
    const start = index;
    while (index < source.length && character() !== "`") {
      if (next() === "\\") index++;
    }
    const inner = source.slice(start, index);
    if (next() !== "`" || !inner.trim()) return invalid();
    // Backticks apply an extra escape pass to their body. Keep complex cases unknown.
    if (inner.includes("\\")) return invalid();
    return shellCommands(inner) ?? invalid();
  }

  function word(command: ShellCommand, depth: number) {
    let value = "", dynamic = false, quote = "", quoted = false;
    const start = index;
    while (index < source.length) {
      const ch = character();
      if (!quote && (/[ \t\r\n;&|<>]/.test(ch) || (depth > 0 && ch === ")"))) break;
      if (ch === "\\" && quote !== "'") {
        next();
        const escaped = next();
        if (escaped === undefined) return invalid();
        if (escaped !== "\n") quoted = true;
        if (escaped === "\n" && quote === '"') return invalid();
        if (escaped !== "\n") value += quote === '"' && !/["\\$`]/.test(escaped) ? "\\" + escaped : escaped;
      } else if (quote && ch === quote) {
        next();
        quote = "";
      } else if (!quote && (ch === "'" || ch === '"')) {
        quote = next();
        quoted = true;
      } else if (quote !== "'" && (ch === "`" || source.startsWith("$(", index))) {
        dynamic = true;
        command.substitutions.push(substitution(depth));
      } else if (quote !== "'" && (ch === "$" || (!quote && /[(){}*?\[\]]/.test(ch)))) {
        if (!quote && !value && source.startsWith("{}", index) && /[ \t\r\n;&|<>]|^$/.test(source[index + 2] ?? "")) {
          value = "{}";
          index += 2;
          continue;
        }
        if (source.startsWith("${", index) || (!quote && /[(){}]/.test(ch))) return invalid();
        dynamic = true;
        value += next();
      } else {
        value += next();
      }
    }
    if (quote || start === index) return invalid();
    return { value, dynamic, quoted };
  }

  function sequence(depth: number, nested = false): ShellCommand[] {
    if (depth > 8) return invalid();
    const commands: ShellCommand[] = [];
    let command: ShellCommand = { words: [], redirects: [], substitutions: [] };
    let needsCommand = false;
    const heredocs: { delimiter: string; tabs: boolean; expand: boolean; command: ShellCommand }[] = [];
    const finish = () => {
      if (!command.words.length && !command.redirects.length && !command.substitutions.length) return false;
      commands.push(command);
      command = { words: [], redirects: [], substitutions: [] };
      needsCommand = false;
      return true;
    };
    while (index < source.length) {
      if (nested && character() === ")") {
        if (heredocs.length) return invalid();
        next();
        finish();
        return commands.length && !needsCommand ? commands : invalid();
      }
      if (/[ \t\r]/.test(character())) { next(); continue; }
      if (source.startsWith("\\\n", index)) { index += 2; continue; }
      if (character() === "#") {
        while (index < source.length && character() !== "\n") next();
        continue;
      }
      if (source.startsWith("<(", index) || source.startsWith(">(", index)) return invalid();
      const operator = at(redirect, source, index);
      if (operator) {
        index += operator.length;
        while (/[ \t]/.test(character())) next();
        const target = word(command, depth);
        if (/^\d*<<-?$/.test(operator)) {
          if (target.dynamic || !target.value) return invalid();
          heredocs.push({ delimiter: target.value, tabs: operator.endsWith("-"), expand: !target.quoted, command });
        } else if (operator.includes(">") &&
          (!operator.endsWith("&") || !/^\d+$|^-$/.test(target.value))) {
          command.redirects.push(target);
        }
        continue;
      }
      const end = at(separator, source, index);
      if (end) {
        index += end.length;
        // Background execution and compound shell operators need a fuller parser.
        if (end === "&" || (!finish() && end !== "\n")) return invalid();
        if (end !== "\n") needsCommand = end !== ";";
        if (end === "\n") {
          for (const heredoc of heredocs.splice(0)) {
            const start = index;
            let found = false;
            while (index < source.length) {
              const newline = source.indexOf("\n", index);
              const endOfLine = newline < 0 ? source.length : newline;
              const line = source.slice(index, endOfLine).replace(/\r$/, "");
              if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
                index = endOfLine + 1;
                found = true;
                break;
              }
              if (heredoc.expand) {
                if (line.endsWith("\\")) return invalid();
                while (index < endOfLine) {
                  if (character() === "\\") { index += 2; continue; }
                  if (character() === "`" || source.startsWith("$(", index)) {
                    heredoc.command.substitutions.push(substitution(depth));
                    if (index > endOfLine) break;
                  } else if (source.startsWith("${", index)) return invalid();
                  else next();
                }
                if (index > endOfLine + 1) continue;
              }
              index = endOfLine + 1;
            }
            if (!found || index <= start) return invalid();
          }
        }
        continue;
      }
      const token = word(command, depth);
      command.words.push({ value: token.value, dynamic: token.dynamic });
    }
    if (nested || heredocs.length) return invalid();
    finish();
    return needsCommand ? invalid() : commands;
  }

  // The common grammar is deliberately bounded; leave the original visible on demand.
  try { return sequence(0); } catch { return null; }
}

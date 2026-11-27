// The end of a message, at most `max` characters, cut where markdown still reads: at the start of a line, and never
// inside a table without its head. When the cut lands among a table's rows, the table's header and separator rows are
// put back in front of the rows that are kept, so the kept rows still read as that table; a table whose head cannot be
// found has its rows before the cut left out. (2026-11-26: a card's context began mid-row, "파일 | 길이 | 크기 |", and
// the table showed as raw text.)
const tableRow = (line: string) => /^\s*\|/.test(line);
const separator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

export function markdownTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) { starts.push(at); at += line.length + 1; }
  const from = (index: number) => text.length - starts[index];
  // The first whole line inside the limit.
  let first = starts.findIndex(start => start >= text.length - max);
  if (first < 0) return text.slice(-max);
  let head = "";
  if (first > 0 && tableRow(lines[first - 1]) && tableRow(lines[first])) {
    let top = first;
    while (top > 0 && tableRow(lines[top - 1])) top--;
    if (top + 1 < lines.length && separator(lines[top + 1])) {
      head = lines[top] + "\n" + lines[top + 1] + "\n";
      first = Math.max(first, top + 2);
      // Keep only the rows that fit after the head.
      while (first < lines.length && head.length + from(first) > max) first++;
      if (first >= lines.length || !tableRow(lines[first])) head = "";
    } else {
      while (first < lines.length && tableRow(lines[first])) first++;
    }
  }
  return (head + lines.slice(first).join("\n")).replace(/^\n+/, "");
}

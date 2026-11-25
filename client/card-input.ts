// A card has one input. The person writes a decision, a question or a change request there, and the session that takes
// it tells which. These are the words and small rules the cards share.
type Bilingual = readonly [string, string];
export type CardKind = "decision" | "merge";
export type CardRecipient = "session" | "coordinator" | "owner";

const recipients: Record<CardRecipient, Bilingual> = {
  session: ["작업 세션", "work session"], coordinator: ["코디네이터", "coordinator"], owner: ["운영 코디네이터", "ledger owner"],
};
const labels: Record<CardKind, Bilingual> = { decision: ["보내기", "Send"], merge: ["수정 요청 보내기", "Send change request"] };

// `label` is on the button, `to` is the line beside it, and `name` is what a screen reader hears.
export function sendWords(kind: CardKind, recipient?: CardRecipient): { label: Bilingual; to: Bilingual | null; name: Bilingual } {
  const label = labels[kind];
  if (!recipient) return { label, to: null, name: label };
  const [ko, en] = recipients[recipient];
  return {
    label, to: ["받는 곳 · " + ko, "To · " + en],
    name: kind === "merge" ? [ko + "에 수정 요청 보내기", "Send change request to " + en] : [ko + "에 보내기", "Send to " + en],
  };
}

export const cardInputPlaceholder: Record<CardKind, Bilingual> = {
  decision: ["답, 질문, 수정 요청을 적어 주세요", "Write your answer, a question or a change request"],
  merge: ["병합하지 않고 고칠 점이나 물어볼 것을 적어 주세요", "Write what to change or ask instead of merging"],
};

// A card with several questions can be sent without answering them all once the card's input says something.
export function openQuestionsBlock(outstanding: boolean, freeReply: string, freePhotos: number) {
  return outstanding && !freeReply.trim() && !freePhotos;
}

// A button that offers a ready request only fills the input: what the person wrote stays, and the request joins it once.
export function withRequest(current: string, request: string) {
  if (!current.trim()) return request;
  return current.includes(request) ? current : current.trimEnd() + "\n\n" + request;
}

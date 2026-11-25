export function isLongReply(text: string) {
  return text.length > 120 || text.includes("\n");
}

// A suggested reply needs a read confirmation only when the input cannot show all of it (it scrolls inside).
// Until the input has measured itself (overflow unknown), the length of the text stands in for that.
export function suggestionOverflows(suggestion: string, overflow: boolean | undefined) {
  return overflow ?? isLongReply(suggestion);
}

export function sessionReplyDraft(suggestion: string | undefined, edited: string | null, reviewed: string | null, hasPhotos: boolean, overflow?: boolean) {
  const text = edited ?? suggestion ?? "";
  const needsReview = !!suggestion && text === suggestion && suggestionOverflows(suggestion, overflow) && reviewed !== suggestion;
  return { text, needsReview, canSend: !needsReview && text.length <= 24000 && (!!text.trim() || hasPhotos) };
}

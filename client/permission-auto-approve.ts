import type { AutoApprovalEntry } from "../shared/permission-auto-approve";
import type { Translate } from "./language";

// The time alone for today, with the date for an earlier day.
export function approvalTime(at: number, language: "ko" | "en", now: number) {
  const locale = language === "ko" ? "ko-KR" : "en-US";
  const date = new Date(at), today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// A record says the session was allowed only after the host reported it.
export function approvalState(entry: Pick<AutoApprovalEntry, "state">, t: Translate) {
  if (entry.state === "sent") return t("응답 보냄 · 세션 확인 전", "Response sent · Not yet confirmed by the session");
  if (entry.state === "other") return t("응답을 보냈지만 다른 응답으로 끝남", "Response sent, but the request ended with another response");
  return "";
}

// One line for a card or the settings list: what answered, which commands, when.
export function approvalLine(entry: AutoApprovalEntry, t: Translate, language: "ko" | "en", now: number) {
  return [t("읽기 전용 자동 승인", "Read-only auto-approval"), entry.summary, approvalTime(entry.at, language, now), approvalState(entry, t)].filter(Boolean).join(" · ");
}

// A session's records, newest first, as the board received them.
export function sessionApprovals(entries: readonly AutoApprovalEntry[] | undefined, sessionId: string) {
  return (entries ?? []).filter(entry => entry.session === sessionId);
}

export function autoApproveExplanation(t: Translate) {
  return t(
    "켜면 보드가 관리하는 작업 세션의 셸 명령 요청 가운데, 모든 명령이 읽기 전용이고 읽는 파일이 그 세션의 작업 폴더 안에 있으며 민감한 이름(.env, 키, 자격 증명 등)이 없는 요청을 한 번만 허용합니다. 파일 쓰기와 삭제, 네트워크, 코드 실행, 파일로 가는 리디렉션, 변수와 명령 치환, git, 알 수 없는 명령, 폴더 전체의 내용 검색, 심볼릭 링크로 작업 폴더를 벗어나는 읽기, 코디네이터 세션의 요청, 질문과 계획 승인은 지금처럼 사람에게 옵니다. '항상 허용'은 보내지 않습니다. Claude Code와 Codex의 셸 요청만 대상이고, 작업 폴더를 알려 주지 않는 실행기(Claude Code)에서는 절대 경로로 쓴 읽기만 허용합니다. 확인과 실행 사이에 같은 세션이 파일을 바꿔치면 막지 못합니다. 믿는 세션에서만 켜세요.",
    "When on, the board allows once a shell request from a work session it manages if every command only reads, every file it reads is inside that session's working folder, and no sensitive name (.env, keys, credentials and the like) appears. File writes and deletes, network access, code execution, redirection to a file, variable and command substitution, git, unknown commands, content searches over a whole folder, reads that leave the working folder through a symbolic link, requests from the coordinator session, questions and plan approvals still come to you. It never sends \"always allow\". Only shell requests from Claude Code and Codex are covered, and for a provider that does not state the working folder (Claude Code) only reads written as absolute paths are allowed. The board cannot stop the same session from swapping a file between the check and the run. Turn this on only for sessions you trust.");
}

export function autoApproveUnsupported(t: Translate) {
  return t("이 호스트는 Windows라서 이 규칙을 쓰지 않습니다. Windows 셸은 명령 줄을 다르게 읽어 읽기 전용 판정을 보장할 수 없습니다. 켜 두어도 모든 요청이 사람에게 옵니다.",
    "This host runs Windows, so the rule is not used. Windows shells read a command line differently, so a read-only verdict cannot be guaranteed. Even when on, every request comes to you.");
}

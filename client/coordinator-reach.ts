import type { CoordinatorReach, CoordinatorReachState } from "../shared/coordinator-reach";
import type { Translate } from "./language";

// The board's coordinator, or a ledger owner other than that coordinator.
export type ReachRole = "coordinator" | "owner";
export type ReachNotice = { title: string; effect: string; steps: string[] };

// What a chip does once a lookup returned. A lookup that failed still opens: the session may be fine.
export function chipOutcome(reach: CoordinatorReach): "open" | "explain" {
  return reach.state === "ok" || reach.state === "closed" || reach.state === "error" || reach.state === "unknown" ? "open" : "explain";
}

// A state the board already holds decides at once. Only a session it does not list is looked up first.
export function chipPlan(known: CoordinatorReach | undefined, canCheck: boolean): "blocked" | "check" | "open" {
  if (known) return chipOutcome(known) === "explain" ? "blocked" : "open";
  return canCheck ? "check" : "open";
}

function subject(role: ReachRole, t: Translate) {
  if (role === "owner") return t("이 원장을 맡은 운영 세션", "The session that owns this ledger");
  return t("운영 코디네이터 세션", "The coordinator session");
}

function title(state: Exclude<CoordinatorReachState, "ok">, who: string, t: Translate) {
  const titles = {
    closed: t(`${who}이 닫혀 있습니다.`, `${who} is closed.`),
    error: t(`${who}이 오류 상태입니다.`, `${who} is in an error state.`),
    archived: t(`${who}이 보관되었습니다.`, `${who} was archived.`),
    "workspace-archived": t(`${who}의 워크스페이스가 보관되었습니다.`, `${who} is in an archived workspace.`),
    "project-missing": t(`${who}의 프로젝트가 Paseo에서 제거되어 워크스페이스가 보관되었습니다.`, `${who} lost its workspace when its project was removed from Paseo.`),
    missing: t(`${who}을 이 호스트에서 찾을 수 없습니다.`, `${who} was not found on this host.`),
    unknown: t(`${who}의 상태를 확인하지 못했습니다.`, `${who} could not be checked.`),
  };
  return titles[state];
}

function effect(state: Exclude<CoordinatorReachState, "ok">, role: ReachRole, t: Translate) {
  if (state === "unknown") return t("코디네이터에게 보내는 요청과 원장 카드 답장이 전달되지 않을 수 있습니다.", "Requests to the coordinator and replies to ledger cards may not be delivered.");
  return role === "owner"
    ? t("이 카드의 답장은 그 세션에 전달되지 않습니다. 쓴 답은 보드에만 저장할 수 있습니다.", "Replies to this card do not reach that session. You can still save your answer on the board.")
    : t("코디네이터에게 보내는 요청과 원장 카드 답장이 전달되지 않습니다.", "Requests to the coordinator and replies to ledger cards are not delivered.");
}

function steps(reach: CoordinatorReach, role: ReachRole, t: Translate) {
  const replace = t("세션이 돌아오지 않으면 새 코디네이터로 교체하세요. 운영 폴더에 새 세션을 만들며 진행 중인 작업과 결정 카드는 유지됩니다.",
    "If the session does not return, replace the coordinator. This creates a session in the operations folder and keeps current work and decision cards.");
  const refresh = t("보드를 새로 고쳐 세션이 다시 보이는지 확인하세요.", "Refresh the board and check that the session is back.");
  const list: string[] = [];
  switch (reach.state) {
    case "project-missing":
    case "workspace-archived":
      list.push(reach.directory
        ? t(`Paseo에서 이 폴더를 프로젝트로 다시 추가하세요. "${reach.directory}" (명령줄에서는 paseo project create "<폴더>")`, `Add this folder to Paseo as a project again. "${reach.directory}" (from a terminal, use paseo project create "<folder>")`)
        : t('Paseo에서 세션이 일하던 폴더를 프로젝트로 다시 추가하세요. (명령줄에서는 paseo project create "<폴더>")', 'Add the folder the session worked in to Paseo as a project again. (From a terminal, use paseo project create "<folder>")'),
        refresh);
      break;
    case "archived":
      list.push(t("보관된 세션은 요청을 받지 않습니다. Paseo에서 보관을 되돌릴 수 있으면 되돌린 뒤 보드를 새로 고치세요.", "An archived session takes no requests. If Paseo lets you restore it, restore it and refresh the board."));
      break;
    case "closed":
      list.push(t("세션을 열어 대화를 이어갈 수 있는지 확인한 뒤 보드를 새로 고치세요.", "Open the session, check whether its conversation can continue, then refresh the board."));
      break;
    case "error":
      list.push(t("세션을 열어 오류를 확인하고, 다시 대기 상태가 되면 보드를 새로 고치세요.", "Open the session to review the error. Refresh the board once it is idle again."));
      break;
    case "missing":
      list.push(t("세션이 삭제되었거나 다른 호스트에 있습니다. 호스트를 확인하세요.", "The session was deleted or lives on another host. Check the host."));
      break;
    case "unknown":
      list.push(t("잠시 뒤 보드를 새로 고치세요. 계속되면 Paseo 호스트 연결을 확인하세요.", "Refresh the board in a moment. If this continues, check the connection to the Paseo host."));
      break;
  }
  if (role === "coordinator" && reach.state !== "unknown") list.push(replace);
  if (role === "owner") list.push(t("원장이 현재 코디네이터를 가리키도록 갱신되면 이 카드의 답장이 새 코디네이터에게 갑니다.", "Once the ledger points to the current coordinator, replies to this card go to that coordinator."));
  return list;
}

export function reachNotice(reach: CoordinatorReach | null | undefined, t: Translate, role: ReachRole = "coordinator"): ReachNotice | null {
  if (!reach || reach.state === "ok") return null;
  return { title: title(reach.state, subject(role, t), t), effect: effect(reach.state, role, t), steps: steps(reach, role, t) };
}

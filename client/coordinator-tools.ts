import type { CoordinatorTools } from "../shared/coordinator-tools";
import type { Translate } from "./language";

// The notice for a Claude coordinator whose conversation remembers older board tools. The second step
// asks the person to type /clear; the board never types it.
export type StaleToolsNotice = { title: string; effect: string; steps: string[] };

export function staleToolsNotice(tools: CoordinatorTools | undefined, t: Translate): StaleToolsNotice | null {
  if (!tools?.stale) return null;
  return {
    title: t("코디네이터가 보드 업데이트 전의 도구 정의를 기억하고 있어 새 기능을 쓰지 못합니다.", "The coordinator remembers the board tools from before the update, so it cannot use new features."),
    effect: t("세션을 다시 띄우거나 Paseo를 다시 시작해도 바뀌지 않습니다. 새 대화로 시작해야 지금 보드의 도구를 받습니다.",
      "Reloading the session or restarting Paseo does not change this. Only a new conversation receives the board's current tools."),
    steps: [
      t("새 세션으로 교체하세요. 운영 폴더에 새 코디네이터를 만들고, 진행 중인 작업과 결정 카드는 그대로 둡니다.",
        "Replace it with a new session. This creates a coordinator in the operations folder and keeps current work and decision cards."),
      t("또는 코디네이터 세션을 열고 /clear 를 직접 입력하세요. 같은 세션에서 새 대화가 시작되며, 이전 대화 내용은 이어지지 않습니다. 보드가 대신 입력하지 않습니다.",
        "Or open the coordinator session and type /clear yourself. A new conversation starts in the same session, without the earlier conversation. The board does not type it for you."),
    ],
  };
}

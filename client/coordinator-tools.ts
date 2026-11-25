import type { CoordinatorTools } from "../shared/coordinator-tools";
import type { Translate } from "./language";

// The notice for a Claude coordinator whose conversation holds board tools older than this board works
// with. The fixes run from least to most context lost. The first needs nothing from the person, and the
// person types the commands of the other two: the board never types them.
export type StaleToolsNotice = { title: string; effect: string; steps: string[] };

export function staleToolsNotice(tools: CoordinatorTools | undefined, t: Translate): StaleToolsNotice | null {
  if (!tools?.stale) return null;
  return {
    title: t("코디네이터 대화가 보드 업데이트 전의 도구 정의를 쓰고 있습니다.", "The coordinator conversation uses board tools from before the update."),
    effect: t("하던 일은 그대로 됩니다. 새 기능은 아래 순서로 받을 수 있고, 위에 있을수록 대화 맥락을 덜 잃습니다.",
      "What it was doing keeps working. It can receive new features in the order below, and the higher a step is, the less of the conversation is lost."),
    steps: [
      t("그대로 두기. 코디네이터가 다음에 보드 도구를 쓰면 보드가 안내 도구(read_board_guide)를 읽으라고 알리고, 읽으면 이 대화에서 새 기능을 쓰며 이 안내가 사라집니다. 바로 하려면 코디네이터 세션에 「보드 안내 도구를 읽어 줘」라고 직접 입력하세요.",
        "Leave it as it is. The next time the coordinator uses a board tool, the board tells it to read the guide tool (read_board_guide). Once it has, it uses new features in this conversation and this notice goes away. To do it now, type \"Read the board guide tool\" in the coordinator session yourself."),
      t("그래도 남아 있으면 코디네이터 세션에 /compact 를 직접 입력하세요. 대화 요약은 남고, 압축이 끝난 뒤 보드를 새로 고치면 이 안내가 사라집니다. Claude Code 2.1.330 에서는 압축한 대화가 도구 정의를 새로 받는 것을 확인했고, 다른 버전에서는 다를 수 있습니다. 보드가 대신 입력하지 않습니다.",
        "If the notice stays, type /compact in the coordinator session yourself. The conversation keeps a summary, and this notice goes away when you refresh the board after the compaction ends. With Claude Code 2.1.330 a compacted conversation was seen to receive the tool definitions again; other versions may differ. The board does not type it for you."),
      t("마지막 수단입니다. 새 세션으로 교체하거나 코디네이터 세션에 /clear 를 직접 입력하세요. 이전 대화 내용은 이어지지 않습니다.",
        "As a last resort, replace it with a new session, or type /clear in the coordinator session yourself. The earlier conversation is not carried over."),
    ],
  };
}

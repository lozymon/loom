import type { CommandName, CommandOf, CommandResults } from "@loom/protocol";
import type { BoardService } from "../board/boardService.ts";
import type { Actor } from "../control/actor.ts";
import type { LoomApi } from "../core/adapter.ts";
import type { SessionManager } from "../core/sessionManager.ts";
import { HubError } from "../errors.ts";
import { route } from "../server/router.ts";

/** Loom tools inside the hub process: the same router and authorization as a WebSocket client. */
export function inProcessApi(manager: SessionManager, boards: () => BoardService | undefined, actor: Actor): LoomApi {
  const unsupported = () => {
    throw new HubError("forbidden", "not available to tools");
  };
  return {
    request<N extends CommandName>(cmd: CommandOf<N>): Promise<CommandResults[N]> {
      return route(cmd, {
        manager,
        actor,
        boards: boards(),
        subscribe: unsupported,
        attachTerminal: unsupported,
        detachTerminal: unsupported,
        watchBoard: () => undefined,
      }) as Promise<CommandResults[N]>;
    },
  };
}

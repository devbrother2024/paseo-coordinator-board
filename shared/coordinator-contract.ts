// The coordinator tool contract: the names and input formats of the tools a coordinator receives.
// A conversation keeps the definitions it loaded, so changing one would leave every running
// coordinator on the old copy. New fields and features go out through board_action instead, and
// read_board_guide tells a conversation what the installed board accepts.
//
// `version` goes up when a tool name or input format changes. `compatibleFrom` is the lowest contract
// a conversation may hold and still work with this board: raise it together with `version` only when
// the change breaks older conversations. test/coordinator-contract.test.ts holds the snapshot.
export const coordinatorContract = { version: 1, compatibleFrom: 1 } as const;
export type CoordinatorContract = { version: number; compatibleFrom: number };

export const boardGuideName = "read_board_guide";
export const boardActionName = "board_action";

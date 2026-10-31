import { create } from "zustand";

/**
 * Optional instruction files chosen in a draft composer. They are attached to
 * the thread once its first turn starts; server persistence stays authoritative.
 */
interface InstructionPickerState {
  readonly byDraft: Record<string, ReadonlyArray<string>>;
  readonly setSelected: (draftId: string, fileIds: ReadonlyArray<string>) => void;
  readonly clear: (draftId: string) => void;
}

export const useInstructionPickerStore = create<InstructionPickerState>((set) => ({
  byDraft: {},
  setSelected: (draftId, fileIds) =>
    set((state) => ({ byDraft: { ...state.byDraft, [draftId]: fileIds } })),
  clear: (draftId) =>
    set((state) => {
      const { [draftId]: _removed, ...rest } = state.byDraft;
      return { byDraft: rest };
    }),
}));

export function selectedInstructionIds(draftId: string | null | undefined): ReadonlyArray<string> {
  return draftId === null || draftId === undefined
    ? []
    : (useInstructionPickerStore.getState().byDraft[draftId] ?? []);
}

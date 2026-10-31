import { FileTextIcon } from "lucide-react";
import { memo, useState } from "react";

import type { InstructionFile } from "../../lib/instructionsApi";
import { readInstructions } from "../../lib/instructionsApi";
import { useInstructionPickerStore } from "../../lib/instructionPickerStore";
import { ComposerControl } from "./ComposerControl";
import { Menu, MenuCheckboxItem, MenuGroupLabel, MenuPopup, MenuTrigger } from "../ui/menu";

const EMPTY: ReadonlyArray<string> = [];

/** Optional instruction files for the thread this draft will create. */
export const ComposerInstructionPicker = memo(function ComposerInstructionPicker(props: {
  draftId: string;
  size?: "sm" | "xs";
}) {
  const selected = useInstructionPickerStore((state) => state.byDraft[props.draftId] ?? EMPTY);
  const setSelected = useInstructionPickerStore((state) => state.setSelected);
  const [files, setFiles] = useState<ReadonlyArray<InstructionFile> | null>(null);
  const [open, setOpen] = useState(false);

  const load = () => {
    if (files !== null) return;
    void readInstructions().then(
      (snapshot) => setFiles(snapshot.files.filter((file) => file.kind === "optional")),
      () => setFiles([]),
    );
  };

  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) load();
      }}
    >
      <MenuTrigger
        render={
          <ComposerControl
            {...(props.size === undefined ? {} : { size: props.size })}
            aria-label="Optional instruction files"
          />
        }
      >
        <FileTextIcon aria-hidden data-composer-control-icon className="size-4" />
        <span data-composer-control-label>
          Instructions
          {selected.length > 0 ? ` (${selected.length})` : ""}
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64">
        <MenuGroupLabel>Optional instruction files</MenuGroupLabel>
        {files === null ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
        ) : files.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No optional files yet. Create one in Settings → Threads.
          </div>
        ) : (
          files.map((file) => (
            <MenuCheckboxItem
              key={file.id}
              checked={selected.includes(file.id)}
              onCheckedChange={(checked) =>
                setSelected(
                  props.draftId,
                  checked
                    ? [...new Set([...selected, file.id])]
                    : selected.filter((id) => id !== file.id),
                )
              }
            >
              {file.title}
            </MenuCheckboxItem>
          ))
        )}
      </MenuPopup>
    </Menu>
  );
});

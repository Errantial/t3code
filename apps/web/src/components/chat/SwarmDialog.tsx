import { NetworkIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  buildSwarmBriefPrompt,
  SWARM_AGENT_LIMIT_OPTIONS,
  type SwarmIsolation,
} from "./swarmBrief";

/** The command palette and the slash menu both open the same dialog. */
export const OPEN_SWARM_EVENT = "t3:open-swarm";

const AGENT_LIMIT_ITEMS = [
  { value: "auto", label: "Let the architect decide" },
  ...SWARM_AGENT_LIMIT_OPTIONS.map((limit) => ({
    value: String(limit),
    label: `${limit} agents at most`,
  })),
];

/**
 * Collects a swarm brief and hands the composed architect message back to the
 * composer. The message is inserted, not sent: the user still chooses to send
 * it, and can edit the plan the architect receives.
 */
export function SwarmDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (prompt: string) => void;
}) {
  const briefId = useId();
  const [brief, setBrief] = useState("");
  const [agentLimit, setAgentLimit] = useState("auto");
  const [isolation, setIsolation] = useState<SwarmIsolation>("shared");
  const trimmed = brief.trim();
  const close = () => props.onOpenChange(false);

  const submit = () => {
    if (trimmed.length === 0) return;
    props.onSubmit(
      buildSwarmBriefPrompt({
        brief: trimmed,
        maxAgents: agentLimit === "auto" ? null : Number(agentLimit),
        isolation,
      }),
    );
    setBrief("");
    setAgentLimit("auto");
    setIsolation("shared");
    close();
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => props.onOpenChange(open)}>
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            // The dialog is portaled, but React still bubbles its submit to the
            // composer form this dialog is rendered under.
            event.stopPropagation();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <NetworkIcon aria-hidden className="me-2 inline size-4 text-muted-foreground" />
              Start a swarm
            </DialogTitle>
            <DialogDescription>
              Describe the outcome. An architect agent designs the roster, picks the provider and
              model for each member, and launches them as child threads you can open and follow from
              the thread's Agents list.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor={briefId}>What should the swarm accomplish?</Label>
                <Textarea
                  id={briefId}
                  size="lg"
                  autoFocus
                  value={brief}
                  placeholder="e.g. Compare three caching approaches, have a reviewer stress-test the winner, and write the migration plan."
                  onChange={(event) => setBrief(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
                <span className="text-muted-foreground text-xs">
                  The brief goes into a new message as an editable prompt. Send it to launch the
                  swarm.
                </span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Team size</Label>
                  <Select
                    value={agentLimit}
                    onValueChange={(value) => {
                      if (typeof value === "string") setAgentLimit(value);
                    }}
                    items={AGENT_LIMIT_ITEMS}
                  >
                    <SelectTrigger size="sm" aria-label="Swarm team size">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {AGENT_LIMIT_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label>Workspace</Label>
                  <label className="flex h-8 items-center gap-2 text-sm">
                    <Checkbox
                      checked={isolation === "worktree"}
                      onCheckedChange={(checked) => setIsolation(checked ? "worktree" : "shared")}
                    />
                    <span className="min-w-0 truncate">One worktree per agent</span>
                  </label>
                  <span className="text-muted-foreground text-xs">
                    {isolation === "worktree"
                      ? "Each member gets its own prepared checkout."
                      : "Members share this thread's checkout."}
                  </span>
                </div>
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              Add swarm brief
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

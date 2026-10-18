import type { ThreadId } from "@t3tools/contracts";

import { Button } from "../ui/button";

interface CivilizationCitizenLinkProps {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly onViewCitizen?: ((threadId: ThreadId) => void) | undefined;
  readonly secondary?: string | undefined;
}

export function CivilizationCitizenLink({
  threadId,
  name,
  onViewCitizen,
  secondary,
}: CivilizationCitizenLinkProps) {
  if (onViewCitizen === undefined) {
    return (
      <span className="wrap-anywhere">
        {name}
        {secondary === undefined ? null : (
          <span className="text-muted-foreground"> · {secondary}</span>
        )}
      </span>
    );
  }

  return (
    <Button
      size="xs"
      variant="ghost"
      aria-label={`View citizen ${name}`}
      className="h-auto min-h-0 max-w-full text-left align-baseline"
      onClick={() => onViewCitizen(threadId)}
    >
      <span className="wrap-anywhere">
        {name}
        {secondary === undefined ? null : (
          <span className="font-normal text-muted-foreground"> · {secondary}</span>
        )}
      </span>
    </Button>
  );
}

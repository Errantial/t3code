import { useAtomValue } from "@effect/atom-react";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import {
  isDefaultThreadDetailsVisibility,
  resolveThreadDetailsVisibility,
  RESET_THREAD_DETAILS_ITEMS,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";
import { anySwarmV2EnabledAtom } from "./swarmAvailability";

/** Menu body that shows and hides thread details items. The card's context menu and Settings share it. */
export function ThreadDetailsItemsMenuItems() {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);
  // With Swarm v2 off everywhere, the menu stays as it was.
  const swarmAvailable = useAtomValue(anySwarmV2EnabledAtom);
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Show in thread details</MenuGroupLabel>
        {THREAD_DETAILS_ITEMS.filter((item) => item.id !== "swarm" || swarmAvailable).map(
          (item) => (
            <MenuCheckboxItem
              key={item.id}
              checked={visibility[item.id]}
              onCheckedChange={(checked) =>
                updateClientSettings({
                  threadDetailsItems: setThreadDetailsItem(getClientSettings(), item, checked),
                })
              }
            >
              {item.label}
            </MenuCheckboxItem>
          ),
        )}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        disabled={isDefaultThreadDetailsVisibility(visibility)}
        onClick={() => updateClientSettings(RESET_THREAD_DETAILS_ITEMS)}
      >
        Reset to default
      </MenuItem>
    </>
  );
}

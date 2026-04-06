import type { ToolbarItemContribution } from "../../../../../core/contributions/types";

interface ToolbarMenuItemProps {
  item: ToolbarItemContribution;
  onExecute: (commandId: string) => void;
  onClose: () => void;
}

export function ToolbarMenuItem({ item, onExecute, onClose }: ToolbarMenuItemProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => {
        onClose();
        onExecute(item.commandId);
      }}
    >
      {item.label}
    </button>
  );
}

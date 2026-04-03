import type { FooterItemDefinition } from "../types/ui";
import { OrderedRegistry } from "./orderedRegistry";

export class FooterItemRegistry extends OrderedRegistry<FooterItemDefinition> {
  registerFooterItem(definition: FooterItemDefinition): void {
    this.register(definition);
  }
}

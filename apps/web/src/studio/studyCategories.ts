import {
  Hexagon,
  LayoutTemplate,
  Package,
  PersonStanding,
  RefreshCw,
  Shirt,
  Smile,
  type LucideIcon,
} from "lucide-react";
import { STUDY_CATEGORY_VALUES, StudyCategory } from "@vengine/shared";

/** Icon per study shelf — shared by the composer's category picker and the
 *  system library's shelf headers so the taxonomy reads identically everywhere. */
export const CATEGORY_ICONS: Record<StudyCategory, LucideIcon> = {
  [StudyCategory.Pose]: PersonStanding,
  [StudyCategory.Expression]: Smile,
  [StudyCategory.Turnaround]: RefreshCw,
  [StudyCategory.Wardrobe]: Shirt,
  [StudyCategory.Symbol]: Hexagon,
  [StudyCategory.Composition]: LayoutTemplate,
  [StudyCategory.Prop]: Package,
};

/** Display order of the shelves (the schema's declaration order). */
export const CATEGORY_ORDER: readonly StudyCategory[] = STUDY_CATEGORY_VALUES;

declare module "lucide-react" {
  import type { FC, SVGProps } from "react";

  export type LucideIcon = FC<SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string }>;

  export const Activity: LucideIcon;
  export const AlertTriangle: LucideIcon;
  export const Brain: LucideIcon;
  export const CheckCircle2: LucideIcon;
  export const Clipboard: LucideIcon;
  export const Clock3: LucideIcon;
  export const Download: LucideIcon;
  export const FileText: LucideIcon;
  export const Filter: LucideIcon;
  export const GitBranch: LucideIcon;
  export const Gauge: LucideIcon;
  export const Play: LucideIcon;
  export const RefreshCcw: LucideIcon;
  export const Search: LucideIcon;
  export const Server: LucideIcon;
  export const ShieldCheck: LucideIcon;
  export const Wifi: LucideIcon;
  export const WifiOff: LucideIcon;
}

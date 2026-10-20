import type { RiverBridge } from "@/core/bridge";

declare global {
  interface Window {
    river: RiverBridge;
  }
}

export {};

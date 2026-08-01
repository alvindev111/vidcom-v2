import type { SchedulerTimers } from "@vidcom/core";

/** Node timer implementation injected at the Core composition boundary. */
export const nodeSchedulerTimers: SchedulerTimers = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

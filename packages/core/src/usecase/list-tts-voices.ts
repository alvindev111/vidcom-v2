import type { TtsProviderDto } from "@vidcom/contracts";

import type { TtsPort } from "../port/tts-port";

/**
 * The TTS catalog a client should render: every registered provider, including
 * ones that cannot run on this machine.
 *
 * Unavailable providers stay in the list with `available: false` and a reason so
 * the UI can say "add an ElevenLabs key" or "install the VieNeu sidecar"
 * instead of silently offering fewer choices than the docs describe. A provider
 * that advertises only `cpu` in `computeDevices` has no usable GPU here.
 */
export async function listTtsVoices(
  dependencies: { tts: TtsPort },
): Promise<{ providers: TtsProviderDto[] }> {
  return { providers: await dependencies.tts.listProviders() };
}

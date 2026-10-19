import { LiteLLMPricingPlugin } from './plugin.ts'

// opencode V2 reads exactly one thing off this module: the default export,
// which must carry an `id` and a `setup` function (plugin.ts type-checks that
// shape with `satisfies Plugin.Plugin`). Named exports are ignored by the V2
// loader, but stay types-only all the same: `export type *` is erased at
// compile time, so no stray value (`LITELLM_CHAT_MODES`) is ever exported.
export default LiteLLMPricingPlugin
export type * from './types.ts'

import { defineNitroPlugin } from "@agent-native/core";
import { registerRequiredSecret } from "@agent-native/core/secrets";

export default defineNitroPlugin(() => {
  registerRequiredSecret({
    key: "GITHUB_TOKEN",
    label: "GitHub token",
    description:
      "Lets Blueprint push a branch and open a pull request. Use a fine-grained token with Contents and Pull requests read/write on the target repo.",
    docsUrl: "https://github.com/settings/personal-access-tokens/new",
    scope: "user",
    kind: "api-key",
    required: false,
  });
});

import { syncChatGPT } from './chatgpt.js';

// This installation archives ChatGPT only.
export const PROVIDERS = {
  chatgpt: {
    name: 'ChatGPT',
    site: 'chatgpt.com',
    description: 'Historical and new ChatGPT conversations',
    defaultEnabled: true,
    sourceId: 'chatgpt-web',
    adapter: 'chatgpt-web',
    sync: syncChatGPT,
  },
};

export const DEFAULT_PROVIDER_SETTINGS = Object.fromEntries(
  Object.entries(PROVIDERS).map(([id, provider]) => [id, provider.defaultEnabled])
);

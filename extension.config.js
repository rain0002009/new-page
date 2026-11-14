import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const markdown = require.resolve('mdast-util-from-markdown', {
  paths: [require.resolve('remark-parse')]
})
const entityDecoder = require.resolve('decode-named-character-reference', { paths: [markdown] })

/** @type {import('extension').FileConfig} */
export default {
  config(config) {
    // The browser decoder requires document at import time; the background
    // service worker needs the package's DOM-free implementation instead.
    config.resolve ??= {}
    config.resolve.alias = {
      ...config.resolve.alias,
      'decode-named-character-reference$': entityDecoder
    }
    // Keep the editor's core dependencies in bounded, cacheable async chunks.
    // Language grammars retain their existing individual dynamic imports.
    config.optimization ??= {}
    const splitChunks = config.optimization.splitChunks || {}
    config.optimization.splitChunks = {
      ...splitChunks,
      cacheGroups: {
        ...splitChunks.cacheGroups,
        documentEditor: {
          test: /[\\/]node_modules[\\/](?:@milkdown|@codemirror|@lezer|@vue|prosemirror[^\\/]*|codemirror|vue)[\\/]/,
          chunks: 'async',
          // A fixed name would merge independently loaded language grammars.
          name: false,
          maxSize: 512 * 1024,
          priority: 20,
        },
      },
    }
    return config
  },
  browser: {
    chrome: {profile: './dist/extension-profile-chrome'}
  }
}

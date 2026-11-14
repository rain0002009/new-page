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
    return config
  },
  browser: {
    chrome: {profile: './dist/extension-profile-chrome'}
  }
}
